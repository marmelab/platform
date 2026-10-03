import Docker from "dockerode";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import * as tar from "tar";
import { config } from "./config.ts";

export interface ServiceSpec {
  name: string;
  image: string;
  app: string;
  service: string;
  env: Record<string, string>;
  cmd?: string[];
  memoryMb: number;
  /** Networks joined besides config.docker.network. */
  networks?: string[];
  /** Named volumes, mounted read-only. */
  volumes?: { source: string; target: string }[];
  /**
   * HTTP readiness check (port and path, any status below 500): with it, a running container is replaced without
   * downtime (ensure()).
   */
  health?: { port: number; path: string };
}

/** What ensure() did: nothing, started a stopped container, created one, or replaced a running one. */
export type EnsureResult = "unchanged" | "started" | "created" | "replaced";

export interface ContainerStatus {
  name: string;
  service: string;
  state: string;
}

export interface RawLogLine {
  ts: string;
  line: string;
}

export interface Orchestrator {
  /**
   * Makes the container match the spec (its hash, and the image the tag currently points to). `force` recreates it
   * anyway (a platform upgrade recycling every app).
   */
  ensure(spec: ServiceSpec, options?: { force?: boolean }): Promise<EnsureResult>;
  /** Pulls the image unless it is already present (DEP-1). */
  ensureImage(image: string): Promise<void>;
  removeApp(app: string): Promise<void>;
  /** Stops the app's containers without removing them (ensure() restarts them). */
  stopApp(app: string): Promise<void>;
  status(app: string): Promise<ContainerStatus[]>;
  logs(container: string, sinceSeconds: number, tail: number): Promise<RawLogLine[]>;
  appContainers(app: string): Promise<ContainerStatus[]>;
  /** Images of the platform's own containers (compose services labelled platform.service), by service. */
  platformImages(): Promise<Record<string, string>>;
  /** Memory used by a running container (Docker's "MEM USAGE": usage minus inactive page cache), null otherwise. */
  memoryUsage(container: string): Promise<number | null>;
  /** Sends a signal to a running container (PostgREST reloads, pgrst-relay.ts). A stopped or missing one is ignored. */
  signal(container: string, signal: string): Promise<void>;
  /** Runs a command in a platform container, its stdout written to a local file. Throws on a non-zero exit. */
  execToFile(container: string, cmd: string[], env: Record<string, string>, file: string): Promise<void>;
  /** Runs a command in a platform container and returns its stdout. Throws on a non-zero exit. */
  exec(container: string, cmd: string[], env?: Record<string, string>): Promise<string>;
  /** Copies local files into a platform container: `<cwd>/<path>` lands at `<dest>/<path>` (parents created). */
  copyTo(container: string, cwd: string, paths: string[], dest: string): Promise<void>;
}

/** Waits until `url` answers below 500. */
export async function waitReady(url: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      if (response.status < 500) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} not ready: ${last}`);
}

/** Splits Docker's multiplexed log stream (non-TTY) into timestamped lines. */
function demux(buffer: Buffer): RawLogLine[] {
  const lines: RawLogLine[] = [];
  let offset = 0;
  const chunks: string[] = [];
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    chunks.push(buffer.subarray(offset + 8, offset + 8 + size).toString("utf8"));
    offset += 8 + size;
  }
  const text = offset === 0 ? buffer.toString("utf8") : chunks.join("");
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const space = raw.indexOf(" ");
    lines.push({ ts: raw.slice(0, space), line: raw.slice(space + 1) });
  }
  return lines;
}

export class DockerOrchestrator implements Orchestrator {
  private docker = new Docker({ socketPath: "/var/run/docker.sock" });
  /** Concurrent ensure() calls for the same missing image share one pull. */
  private pulls = new Map<string, Promise<void>>();

  async ensureImage(image: string): Promise<void> {
    if (await this.docker.getImage(image).inspect().then(() => true, () => false)) return;
    let pull = this.pulls.get(image);
    if (!pull) {
      pull = this.pull(image).finally(() => this.pulls.delete(image));
      this.pulls.set(image, pull);
    }
    await pull;
  }

  private async pull(image: string) {
    console.log(`pulling ${image}`);
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) =>
      this.docker.modem.followProgress(stream, (error: Error | null) => (error ? reject(error) : resolve()))
    );
    console.log(`pulled ${image}`);
  }

  async ensure(spec: ServiceSpec, { force = false }: { force?: boolean } = {}): Promise<EnsureResult> {
    const hash = createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16);
    const existing = this.docker.getContainer(spec.name);
    const info = await existing.inspect().catch(() => null);
    await this.ensureImage(spec.image);
    if (info) {
      // the tag may point to another image since the container was created (a rebuilt or re-pulled image)
      const imageId = (await this.docker.getImage(spec.image).inspect()).Id;
      const current = info.Config.Labels?.["platform.config-hash"] === hash && info.Image === imageId;
      if (current && !force) {
        if (info.State.Running) return "unchanged";
        await existing.start();
        return "started";
      }
      if (info.State.Running && spec.health) {
        await this.replace(spec, hash, existing);
        return "replaced";
      }
      await existing.remove({ force: true });
    }
    await this.create(spec, spec.name, hash);
    return "created";
  }

  private async create(spec: ServiceSpec, name: string, hash: string) {
    const container = await this.docker.createContainer({
      name,
      Image: spec.image,
      Cmd: spec.cmd,
      Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
      Labels: {
        "platform.managed": "true",
        "platform.app": spec.app,
        "platform.service": spec.service,
        "platform.config-hash": hash,
      },
      HostConfig: {
        NetworkMode: config.docker.network,
        Memory: spec.memoryMb * 1024 * 1024,
        RestartPolicy: { Name: "unless-stopped" },
        Mounts: spec.volumes?.map((v) => ({ Type: "volume" as const, Source: v.source, Target: v.target, ReadOnly: true })),
      },
      // a replacement container answers to the service's name too (replace())
      NetworkingConfig: { EndpointsConfig: { [config.docker.network]: { Aliases: [spec.name] } } },
    });
    for (const network of spec.networks ?? []) await this.docker.getNetwork(network).connect({ Container: container.id });
    await container.start();
    return container;
  }

  /**
   * Replaces a running container without downtime (A8 rolling recycle, configure_auth, SMTP changes): the new
   * container starts next to the old one as `<name>-next`, with `<name>` as a network alias, so that Caddy's upstream
   * (`<name>:<port>`, resolved for each new connection) reaches either of them; once it answers its readiness check,
   * the old one is stopped (graceful, 10 s), removed, and the new one renamed. If the new one never gets ready, it is
   * removed and the old one keeps serving.
   */
  private async replace(spec: ServiceSpec, hash: string, old: Docker.Container) {
    const nextName = `${spec.name}-next`;
    await this.docker.getContainer(nextName).remove({ force: true }).catch(() => {});
    const next = await this.create(spec, nextName, hash);
    try {
      await waitReady(`http://${nextName}:${spec.health!.port}${spec.health!.path}`);
    } catch (error) {
      await next.remove({ force: true }).catch(() => {});
      throw new Error(`${spec.name}: the new container did not get ready, the old one keeps serving: ${error}`);
    }
    await old.stop({ t: 10 }).catch(() => {});
    await old.remove({ force: true });
    await next.rename({ name: spec.name });
  }

  async appContainers(app: string): Promise<ContainerStatus[]> {
    const list = await this.docker.listContainers({
      all: true,
      filters: { label: [`platform.app=${app}`, "platform.managed=true"] },
    });
    return list.map((c) => ({
      name: c.Names[0]?.replace(/^\//, "") ?? c.Id,
      service: c.Labels["platform.service"] ?? "unknown",
      state: c.State,
    }));
  }

  status(app: string) {
    return this.appContainers(app);
  }

  async platformImages(): Promise<Record<string, string>> {
    const list = await this.docker.listContainers({ all: true, filters: { label: ["platform.service"] } });
    const images: Record<string, string> = {};
    for (const c of list) {
      if (c.Labels["platform.managed"] === "true") continue;
      images[c.Labels["platform.service"]!] = c.Image;
    }
    return Object.fromEntries(Object.entries(images).sort(([a], [b]) => a.localeCompare(b)));
  }

  async memoryUsage(container: string): Promise<number | null> {
    // one-shot: no wait for a second CPU sample (Docker API >= 1.41)
    type Stats = { memory_stats?: { usage?: number; stats?: Record<string, number> } };
    const request = this.docker.getContainer(container)
      .stats({ stream: false, "one-shot": true } as never) as unknown as Promise<Stats>;
    const stats = await request.catch(() => null);
    const memory = stats?.memory_stats;
    if (!memory?.usage) return null;
    // cgroup v2: inactive_file; cgroup v1: total_inactive_file (as the docker CLI)
    const cache = memory.stats?.inactive_file ?? memory.stats?.total_inactive_file ?? 0;
    return Math.max(0, memory.usage - (cache < memory.usage ? cache : 0));
  }

  async removeApp(app: string): Promise<void> {
    for (const c of await this.appContainers(app)) {
      await this.docker.getContainer(c.name).remove({ force: true });
    }
  }

  async stopApp(app: string): Promise<void> {
    for (const c of await this.appContainers(app)) {
      if (c.state === "running" || c.state === "restarting") await this.docker.getContainer(c.name).stop();
    }
  }

  async signal(container: string, signal: string): Promise<void> {
    try {
      await this.docker.getContainer(container).kill({ signal });
    } catch (error) {
      // 404: no such container; 409: not running
      const status = (error as { statusCode?: number }).statusCode;
      if (status !== 404 && status !== 409) throw error;
    }
  }

  async execToFile(container: string, cmd: string[], env: Record<string, string>, file: string): Promise<void> {
    const exec = await this.docker.getContainer(container).exec({
      Cmd: cmd,
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const out = createWriteStream(file, { mode: 0o600 });
    const err = new PassThrough();
    const stderr: Buffer[] = [];
    err.on("data", (chunk: Buffer) => stderr.push(chunk));
    this.docker.modem.demuxStream(stream, out, err);
    await finished(stream, { writable: false });
    out.end();
    await finished(out);
    const { ExitCode } = await exec.inspect();
    if (ExitCode !== 0) {
      throw new Error(`${cmd[0]} exited with ${ExitCode}: ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 2000)}`);
    }
  }

  async exec(container: string, cmd: string[], env: Record<string, string> = {}): Promise<string> {
    const exec = await this.docker.getContainer(container).exec({
      Cmd: cmd,
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const out = new PassThrough();
    const err = new PassThrough();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    out.on("data", (chunk: Buffer) => stdout.push(chunk));
    err.on("data", (chunk: Buffer) => stderr.push(chunk));
    this.docker.modem.demuxStream(stream, out, err);
    await finished(stream, { writable: false });
    const { ExitCode } = await exec.inspect();
    if (ExitCode !== 0) {
      throw new Error(`${cmd[0]} exited with ${ExitCode}: ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 2000)}`);
    }
    return Buffer.concat(stdout).toString("utf8");
  }

  async copyTo(container: string, cwd: string, paths: string[], dest: string): Promise<void> {
    const archive = tar.c({ cwd, portable: true }, paths);
    await this.docker.getContainer(container).putArchive(archive as unknown as NodeJS.ReadableStream, { path: dest });
  }

  async logs(container: string, sinceSeconds: number, tail: number): Promise<RawLogLine[]> {
    const buffer = (await this.docker.getContainer(container).logs({
      stdout: true,
      stderr: true,
      timestamps: true,
      since: Math.floor(Date.now() / 1000) - sinceSeconds,
      tail,
      follow: false,
    })) as unknown as Buffer;
    return demux(buffer);
  }
}

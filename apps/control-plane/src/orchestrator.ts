import Docker from "dockerode";
import { createHash } from "node:crypto";
import { config } from "./config.ts";

export interface ServiceSpec {
  name: string;
  image: string;
  app: string;
  service: string;
  env: Record<string, string>;
  cmd?: string[];
  memoryMb: number;
}

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
  ensure(spec: ServiceSpec): Promise<void>;
  removeApp(app: string): Promise<void>;
  status(app: string): Promise<ContainerStatus[]>;
  logs(container: string, sinceSeconds: number, tail: number): Promise<RawLogLine[]>;
  appContainers(app: string): Promise<ContainerStatus[]>;
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

  async ensure(spec: ServiceSpec): Promise<void> {
    const hash = createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16);
    const existing = this.docker.getContainer(spec.name);
    const info = await existing.inspect().catch(() => null);
    if (info) {
      if (info.Config.Labels?.["platform.config-hash"] === hash) {
        if (!info.State.Running) await existing.start();
        return;
      }
      await existing.remove({ force: true });
    }
    const container = await this.docker.createContainer({
      name: spec.name,
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
      },
    });
    await container.start();
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

  async removeApp(app: string): Promise<void> {
    for (const c of await this.appContainers(app)) {
      await this.docker.getContainer(c.name).remove({ force: true });
    }
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

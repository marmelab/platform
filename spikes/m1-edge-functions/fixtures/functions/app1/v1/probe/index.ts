async function attempt(fn: () => Promise<unknown>) {
  try {
    const value = await fn();
    return { ok: true, value: typeof value === "string" ? value.slice(0, 120) : value };
  } catch (error) {
    return { ok: false, error: `${(error as Error).name}: ${(error as Error).message}`.slice(0, 160) };
  }
}

const other = Deno.env.get("APP_NAME") === "app1" ? "app2" : "app1";
const self = Deno.env.get("APP_NAME");

async function callMain(host: string, app: string) {
  const res = await fetch(`http://${host}/hello`, { headers: { "x-platform-app": app } });
  return `${res.status} ${(await res.text()).slice(0, 80)}`;
}

Deno.serve(async () =>
  Response.json({
    readOtherConfig: await attempt(() => Deno.readTextFile(`/config/apps/${other}.json`)),
    readOwnConfig: await attempt(() => Deno.readTextFile(`/config/apps/${self}.json`)),
    readOtherFunction: await attempt(() => Deno.readTextFile(`/functions/${other}/current/hello/index.ts`)),
    listFunctionsRoot: await attempt(async () => (await Array.fromAsync(Deno.readDir("/functions"))).map((e) => e.name)),
    readProcEnviron: await attempt(() => Deno.readTextFile("/proc/self/environ")),
    readMainWorker: await attempt(() => Deno.readTextFile("/main/index.ts")),
    readOwnFunction: await attempt(() => Deno.readTextFile(new URL("./index.ts", import.meta.url))),
    writeTmp: await attempt(() => Deno.writeTextFile(`/tmp/marker-${self}.txt`, `written by ${self}`)),
    readOtherTmp: await attempt(() => Deno.readTextFile(`/tmp/marker-${other}.txt`)),
    writeFunctions: await attempt(() => Deno.writeTextFile(`/functions/${self}/current/pwned.ts`, "x")),
    runCommand: await attempt(() => new Deno.Command("id").output().then((o) => new TextDecoder().decode(o.stdout))),
    callMainLocalhost: await attempt(() => callMain("127.0.0.1:9000", other)),
    callMainByServiceName: await attempt(() => callMain("edge:9000", other)),
    callCaddyAdmin: await attempt(async () => (await fetch("http://caddy:2019/config/")).status),
    envKeys: Object.keys(Deno.env.toObject()).sort(),
  })
);

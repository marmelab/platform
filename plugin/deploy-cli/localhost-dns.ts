// Resolves *.localhost to 127.0.0.1, which macOS's system resolver does not do (browsers and curl do it themselves).
// Imported first by main.ts; the e2e tests load it with NODE_OPTIONS="--import <repo>/plugin/deploy-cli/localhost-dns.ts".
import dns, { type LookupAddress, type LookupOptions } from "node:dns";

type Callback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

const lookup = dns.lookup;
dns.lookup = function (this: unknown, hostname: string, options: LookupOptions | number | Callback, callback?: Callback) {
  if (typeof options === "function") [callback, options] = [options, {}];
  if (typeof options === "number") options = { family: options };
  if (hostname.endsWith(".localhost")) {
    if (options.all) return process.nextTick(callback!, null, [{ address: "127.0.0.1", family: 4 }]);
    return process.nextTick(callback!, null, "127.0.0.1", 4);
  }
  return Reflect.apply(lookup, this, [hostname, options, callback]);
} as typeof dns.lookup;

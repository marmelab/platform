// Resolves *.localhost to 127.0.0.1 in Node on macOS, whose system resolver does not (browsers and curl do it themselves).
// Usage: export NODE_OPTIONS="--import $PWD/deploy/localhost-dns.mjs"
import dns from "node:dns";

const lookup = dns.lookup;
dns.lookup = function (host, options, callback) {
  if (typeof options === "function") [callback, options] = [options, {}];
  if (typeof options === "number") options = { family: options };
  if (typeof host === "string" && host.endsWith(".localhost")) {
    if (options?.all) return process.nextTick(callback, null, [{ address: "127.0.0.1", family: 4 }]);
    return process.nextTick(callback, null, "127.0.0.1", 4);
  }
  return lookup.call(this, host, options, callback);
};

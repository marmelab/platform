// GitHub as the code relay's routes reach it in ci.e2e.test.ts, run inside the control plane container (node -e, the
// port as argument): repository creation refused (422), every commit refused as behind, every other request echoed.
// Exits when its stdin ends, so with the test that started it.
const http = require("node:http");

const answer = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

http.createServer((req, res) => {
  req.resume().on("end", () => {
    if (req.method === "POST" && /^\/api\/v3\/orgs\/[^/]+\/repos$/.test(req.url)) {
      return answer(res, 422, {
        message: "Repository creation failed.",
        errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }],
      });
    }
    if (req.method === "POST" && req.url === "/api/graphql") {
      return answer(res, 200, { errors: [{ type: "STALE_DATA", message: "Expected branch to point to the session's head" }] });
    }
    answer(res, 200, { method: req.method, url: req.url });
  });
}).listen(Number(process.argv[1]), "127.0.0.1", () => console.log("ready"));

process.stdin.on("end", () => process.exit()).resume();
setTimeout(() => process.exit(), 10 * 60_000).unref();

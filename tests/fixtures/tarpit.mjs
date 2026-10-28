// tests/fixtures/tarpit.mjs — つながるが何も返さないサーバ。
//
// モデルの取得先 (huggingface.co) を --host-resolver-rules でここに向けて、取得が止まった状態を作る
// (docs/release-1.7.1.md の T-SC-20)。TLS の握手に答えないので、ブラウザの fetch はいつまでも返らない。
// 接続を拒否するサーバだとすぐに失敗が返り、「止まった」状態にはならない。
import net from "node:net";

export function startTarpit() {
  const sockets = new Set();
  let connections = 0;
  const server = net.createServer((s) => {
    connections++;
    sockets.add(s);
    s.on("error", () => {});
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        /** --host-resolver-rules に足す行 (harness の launch({ hostRules })) */
        rulesFor: (...hosts) => hosts.map((h) => `MAP ${h} 127.0.0.1:${port}`),
        connections: () => connections,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  });
}

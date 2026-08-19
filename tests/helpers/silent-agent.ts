// Deliberately never reads stdin and never prints anything — an agent that
// accepts the connection but never speaks ACP (current cursor-agent behavior).
export {};

const forever = new Promise(() => {});
process.stdin.resume();
await forever;

import { expect, it } from "vitest";
import { bufferedChannel } from "./process-events";
it("replays immediate process output and exit delivered before the spawn promise", () => {
  const stream = bufferedChannel<string>();
  stream.emit("first"); stream.emit("exit");
  const received: string[] = [];
  stream.on((s) => received.push(s));
  stream.emit("later");
  expect(received).toEqual(["first", "exit", "later"]);
});

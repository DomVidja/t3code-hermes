import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
let pending;
let setup;
let terminal;
NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === "permission" && message.result) {
    if (process.env.T3_FIXTURE_GRANDCHILD && message.result.outcome.optionId === "allowed") {
      // Hermes terminal commands use start_new_session and outlive the ACP process group.
      terminal = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "setTimeout(() => process.exit(0), 30000)"],
        { stdio: "ignore", detached: true },
      );
      terminal.once("spawn", () =>
        NodeFS.writeFileSync(`${process.env.HERMES_HOME}/terminal.pid`, String(terminal.pid)),
      );
      return;
    }
    send({
      method: "session/update",
      params: {
        sessionId: "child",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text:
              message.result.outcome.outcome === "selected"
                ? message.result.outcome.optionId
                : "cancelled",
          },
        },
      },
    });
    send({ id: pending, result: { stopReason: "end_turn" } });
    return;
  }
  if (!message.method) return;
  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
      });
      break;
    case "authenticate":
      send({ id: message.id, result: {} });
      break;
    case "session/new":
      setup = message.params;
      send({
        id: message.id,
        result: {
          sessionId: "child",
          _meta: process.env.T3_FIXTURE_NO_HANDSHAKE
            ? {}
            : {
                t3SupervisedProfileDelegationAccepted: {
                  version: 1,
                  accepted: true,
                  delegationId: message.params._meta.t3SupervisedProfileDelegation.delegationId,
                  permissionMode: "supervised",
                  effectiveToolNames:
                    message.params._meta.t3SupervisedProfileDelegation.allowedToolNames,
                  mcpEnabled: false,
                  nestedDelegation: false,
                },
              },
        },
      });
      break;
    case "session/prompt":
      pending = message.id;
      NodeFS.writeFileSync(
        `${process.env.HERMES_HOME}/prompt.json`,
        JSON.stringify({
          yolo: process.env.HERMES_YOLO_MODE ?? null,
          mcpServers: setup.mcpServers,
          metadata: setup._meta.t3SupervisedProfileDelegation,
        }),
      );
      send({
        id: "permission",
        method: "session/request_permission",
        params: {
          sessionId: "child",
          toolCall: {
            toolCallId: "same-id",
            title: "fixture write",
            kind: "execute",
            status: "pending",
            rawInput: {},
          },
          options: [
            { optionId: "allowed", name: "Allow", kind: "allow_once" },
            { optionId: "denied", name: "Deny", kind: "reject_once" },
          ],
        },
      });
      break;
    case "session/cancel":
      if (terminal) {
        NodeFS.writeFileSync(`${process.env.HERMES_HOME}/cancel-started`, "received");
        // ACP cancellation is asynchronous: reply only after the owned command exits.
        setTimeout(() => {
          terminal.once("exit", () => {
            NodeFS.writeFileSync(`${process.env.HERMES_HOME}/cancel-cleaned`, "terminated");
            send({ id: pending, result: { stopReason: "cancelled" } });
          });
          terminal.kill("SIGTERM");
        }, 200);
        return;
      }
      if (pending !== undefined) send({ id: pending, result: { stopReason: "cancelled" } });
      break;
  }
});

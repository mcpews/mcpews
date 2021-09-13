# MCPEWS

A library that supports MCPE Websocket Protocol.

## Usage

Server-side:
```javascript
const { WSServer }  = require("mcpews");
const server = new WSServer(19134); // port

server.on("client", session => {
    // someone type "/connect <ip address>:19134" in the game console

    // execute a command
    session.sendCommand("say Connected!");

    // execute a command and receive the response
    session.sendCommand("list", res => {
        console.log("currentPlayerCount = " + res.currentPlayerCount);
    });

    // subscribe a event
    session.subscribe("PlayerMessage", event => {
        // when event triggered
        const { properties } = event;
        if (properties.Message == "close") {
            // disconnect from the game
            session.disconnect();
        } else if (properties.MessageType == "chat") {
            session.sendCommand("say You just said " + properties.Message);
        }
    });

    // enable encrypted connection
    session.enableEncryption();
});
```

Client-side:
```javascript
const { WSClient }  = require("mcpews");
const client = new WSClient("ws://127.0.0.1:19134"); // address

process.stdin.on("data", buffer => {
    // trigger a event (will be ignored if not subscribed)
    client.emitEvent("input", {
        data: buffer.toString()
    });
});

client.on("command", (requestId, commandLine) => {
    // pass encryption handshake to client itself
    if (client.handleEncryptionHandshake(requestId, commandLine)) return;

    // command received
    console.log("command: " + commandLine);

    // respond the command, must called after handling
    client.respondCommand(requestId, {
        length: commandLine.length
    });
});
```

REPL:
```
mcpews [<custom port>]
```

MITM:
```
mcpewsmitm <destination address> [<listen port>]
```
const WSServer = require("./server");
const WSClient = require("./client");

function main(destAddress, sourcePort) {
    let wss = new WSServer(sourcePort);
    console.log(`Enter '/connect <ip address>:${sourcePort}' to establish a connection.`);
    console.log(`If connection established, mitm will connect to ${destAddress} and forward messages`);
    wss.on("client", session => {
        let client = new WSClient(destAddress);
        console.log(`<- connected`);
        client.on("command", (requestId, commandLine) => {
            if (client.handleEncryptionHandshake(requestId, commandLine)) {
                console.log(`-> keyExchange: ${requestId}`);
            } else {
                session.sendCommandRaw(requestId, commandLine);
                console.log(`-> command: ${requestId} ${commandLine}`);
            }
        });
        client.on("commandLegacy", (requestId, commandName, overload, input) => {
            session.sendCommandLegacyRaw(requestId, commandName, overload, input);
            console.log(`-> commandLegacy: ${requestId} ${commandName} ${overload}`, input);
        });
        client.on("subscribe", eventName => {
            session.subscribeRaw(eventName);
            console.log(`-> subscribe: ${eventName}`);
        });
        client.on("unsubscribe", eventName => {
            session.unsubscribeRaw(eventName);
            console.log(`-> unsubscribe: ${eventName}`);
        });
        client.on("disconnect", () => {
            console.log(`-> disconnected from client`);
            session.disconnect(true);
        });
        session.on("mcError", (statusCode, statusMessage) => {
            client.sendError(statusCode, statusMessage);
            console.log(`<- error: ${statusMessage}`);
        });
        session.on("event", (eventName, body) => {
            client.emitEvent(eventName, body);
            console.log(`<- event: ${eventName}`, body);
        });
        session.on("commandResponse", (requestId, body) => {
            client.respondCommand(requestId, body);
            console.log(`<- commandResponse: ${requestId}`, body);
        });
        session.on("disconnect", () => {
            console.log(`<- disconnected from server`);
            client.disconnect();
        });
    });
}

main(process.argv[2], process.argv[3] || 19135);
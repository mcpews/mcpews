#!/usr/bin/env node

import { WSServer, WSClient, Version, type ChatEventBody } from './index.js';

function main(destAddress: string, sourcePort: number) {
    if (!destAddress) {
        console.log(
            `Please provide <destination>.
Usage: mcpewsmitm <destination> [port]`.trim()
        );
        process.exit(1);
    }
    const wss = new WSServer(sourcePort);
    let clientCounter = 1;
    console.log(`Enter '/connect <ip address>:${sourcePort}' to establish a connection.`);
    console.log(`If connection established, mitm will connect to ${destAddress} and forward messages`);
    wss.on('client', ({ session }) => {
        const client = new WSClient(`ws://${destAddress}`);
        const clientNo = clientCounter;
        clientCounter += 1;
        let serverVersion: Version = NaN;
        let clientVersion: Version = NaN;
        console.log(`<- [${clientNo}] connected`);
        client.on('command', (event) => {
            if (event.handleEncryptionHandshake()) {
                console.log(`-> [${clientNo}] keyExchange: ${event.requestId}`);
                session.enableEncryption(() => {
                    console.log(`<- [${clientNo}] completeEncryption`);
                });
            } else {
                const { requestId, commandLine } = event;
                session.sendCommandRaw(requestId, commandLine);
                console.log(`-> [${clientNo}] command: ${requestId} ${commandLine}`);
            }
        });
        client.on('commandLegacy', ({ requestId, commandName, overload, input }) => {
            session.sendCommandLegacyRaw(requestId, commandName, overload, input);
            console.log(`-> [${clientNo}] commandLegacy: ${requestId} ${commandName} ${overload}`, input);
        });
        client.on('subscribe', ({ eventName }) => {
            session.subscribeRaw(eventName);
            console.log(`-> [${clientNo}] subscribe: ${eventName}`);
        });
        client.on('unsubscribe', ({ eventName }) => {
            session.unsubscribeRaw(eventName);
            console.log(`-> [${clientNo}] unsubscribe: ${eventName}`);
        });
        client.on('agentAction', ({ requestId, commandLine }) => {
            session.sendAgentCommandRaw(requestId, commandLine);
            console.log(`-> [${clientNo}] agentAction: ${requestId} ${commandLine}`);
        });
        client.on('chatSubscribe', ({ requestId, sender, receiver, chatMessage }) => {
            session.subscribeChatRaw(requestId, sender, receiver, chatMessage);
            const desc = `${sender ?? '*'} -> ${receiver ?? '*'} : ${chatMessage}`;
            console.log(`-> [${clientNo}] subscribeChat: ${requestId} ${desc}`);
        });
        client.on('chatUnsubscribe', ({ subscribeRequestId }) => {
            session.unsubscribeChatRaw(subscribeRequestId);
            console.log(`-> [${clientNo}] unsubscribeChat: ${subscribeRequestId}`);
        });
        client.on('encryptRequest', () => {
            session.enableEncryption(() => {
                console.log(`<- [${clientNo}] completeEncryption`);
            });
            console.log(`-> [${clientNo}] encryptRequest (v2)`);
        });
        client.on('customFrame', ({ message }) => {
            session.sendMessage(message);
            console.log(`-> [${clientNo}] unknown:`, message);
        });
        client.on('message', ({ version }) => {
            if (version !== clientVersion) {
                clientVersion = version;
                console.log(`-> [${clientNo}] version: ${clientVersion}`);
            }
        });
        client.on('disconnect', () => {
            console.log(`-> [${clientNo}] disconnected from client`);
            session.disconnect(true);
        });

        session.on('clientError', ({ requestId, statusCode, statusMessage }) => {
            client.sendError(statusCode, statusMessage, requestId);
            console.log(`<- [${clientNo}] error: ${statusMessage}`);
        });
        session.on('event', ({ requestId, purpose, eventName, body }) => {
            if (purpose === 'chat') {
                const chatBody = body as ChatEventBody;
                client.sendChat(requestId, chatBody.type, chatBody.sender, chatBody.receiver, chatBody.message);
            } else {
                client.publishEvent(eventName, body);
            }
            console.log(`<- [${clientNo}] ${purpose}: ${eventName}`, body);
        });
        session.on('commandResponse', ({ requestId, body }) => {
            client.respondCommand(requestId, body);
            console.log(`<- [${clientNo}] commandResponse: ${requestId}`, body);
        });
        session.on('customFrame', ({ message }) => {
            client.sendMessage(message);
            console.log(`<- [${clientNo}] unknown:`, message);
        });
        session.on('message', ({ version }) => {
            if (version !== serverVersion) {
                serverVersion = version;
                console.log(`<- [${clientNo}] version: ${serverVersion}`);
            }
        });
        session.on('disconnect', () => {
            console.log(`<- [${clientNo}] disconnected from server`);
            client.disconnect();
        });
    });
}

main(process.argv[2], parseInt(process.argv[3]) || 19135);

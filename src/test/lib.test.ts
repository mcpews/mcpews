import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import getPort from 'get-port';
import { pEvent } from 'p-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import {
    type AgentActionFrame,
    type AgentActionResponseFrame,
    type AppSession,
    type AppSessionConnection,
    type ChatEventFrame,
    ChatEventFrameType,
    type ChatSubscribeFrame,
    type ChatUnsubscribeFrame,
    type ClientConnection,
    type ClientError,
    type CommandFrame,
    type CommandResponseFrame,
    type DataFrame,
    type DataRequestFrame,
    EncryptionMode,
    type EncryptRequest,
    type EventFrame,
    type LegacyCommandFrame,
    MinecraftAgentActionType,
    MinecraftDataType,
    type ServerSession,
    type SubscribeFrame,
    type UnsubscribeFrame,
    Version,
    WSApp,
    WSClient,
    WSServer,
} from '../index.js';

const port = await getPort({ port: 19134 });

describe('basic server and client', () => {
    let server: WSServer;
    let session: ServerSession;
    let client: WSClient;
    beforeEach(async () => {
        server = new WSServer(port);
        const callback = vi.fn<(client: ClientConnection) => void>();
        server.once('client', callback);
        client = new WSClient(`ws://127.0.0.1:${port}`);
        await vi.waitFor(() => expect(callback).toHaveBeenCalled());
        session = callback.mock.calls[0][0].session;
        if (session.socket.readyState !== WebSocket.OPEN) {
            await pEvent(session.socket, 'open');
        }
        if (client.socket.readyState !== WebSocket.OPEN) {
            await pEvent(client.socket, 'open');
        }
    });
    afterEach(async () => {
        (session as ServerSession | undefined)?.disconnect(true);
        (client as WSClient | undefined)?.disconnect();
        await new Promise((resolve) => {
            server.close(resolve);
        });
    });

    test('send command and respond', async () => {
        const expectedCommand = '/say Hi, there!';
        const expectedResponse = { message: 'Yes! I am here!' };

        const sendCallback = vi.fn((frame: CommandFrame) => {
            // #2 respond command
            if (frame.handleEncryptionHandshake()) {
                return;
            }
            frame.respond(expectedResponse);
        });
        const recvCallback = vi.fn<(frame: CommandResponseFrame) => void>();
        client.on('command', sendCallback);

        // #1 send command request
        const requestId = session.sendCommand(expectedCommand, recvCallback);

        // #3 receive response
        await vi.waitFor(() => expect(recvCallback).toHaveBeenCalled());
        const response = recvCallback.mock.calls[0][0];
        expect(response.body).toEqual(expectedResponse);
        expect(response.requestId).toBe(requestId);

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandLine).toBe(expectedCommand);
        expect(sendCallback.mock.calls[0][0].requestId).toBe(requestId);

        client.off('command', sendCallback);
    });

    test('send command respond raw', async () => {
        const expectedCommand = ['/say', 'Hi, there!'];
        const expectedResponse = { message: 'Yes! I am here!' };
        const requestId = randomUUID();

        const sendCallback = vi.fn((frame: CommandFrame) => {
            // #2 respond command
            client.respondCommand(frame.requestId, expectedResponse);
        });
        const recvCallback = vi.fn<(frame: CommandResponseFrame) => void>();
        client.on('command', sendCallback);
        session.on('commandResponse', recvCallback);

        // #1 send command request
        session.sendCommandRaw(requestId, expectedCommand);

        // #3 receive response
        await vi.waitFor(() => expect(recvCallback).toHaveBeenCalled());
        const response = recvCallback.mock.calls[0][0];
        expect(response.body).toEqual(expectedResponse);
        expect(response.requestId).toBe(requestId);

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandLine).toBe(expectedCommand.join(' '));
        expect(sendCallback.mock.calls[0][0].requestId).toBe(requestId);

        client.off('command', sendCallback);
        session.off('commandResponse', recvCallback);
    });

    test('send legacy command and respond', async () => {
        const expectedCommand = 'say';
        const expectedOverload = 'default';
        const expectedInput = { text: 'Hi there!' };
        const expectedResponse = { message: 'Yes! I am here!' };

        const sendCallback = vi.fn((frame: LegacyCommandFrame) => {
            // #2 respond command
            frame.respond(expectedResponse);
        });
        const recvCallback = vi.fn<(frame: CommandResponseFrame) => void>();
        client.on('commandLegacy', sendCallback);

        // #1 send command request
        const requestId = session.sendCommandLegacy(expectedCommand, expectedOverload, expectedInput, recvCallback);

        // #3 receive response
        await vi.waitFor(() => expect(recvCallback).toHaveBeenCalled());
        const response = recvCallback.mock.calls[0][0];
        expect(response.body).toEqual(expectedResponse);
        expect(response.requestId).toBe(requestId);

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandName).toBe(expectedCommand);
        expect(sendCallback.mock.calls[0][0].overload).toBe(expectedOverload);
        expect(sendCallback.mock.calls[0][0].input).toEqual(expectedInput);
        expect(sendCallback.mock.calls[0][0].requestId).toBe(requestId);
        expect(() => {
            (sendCallback.mock.calls[0][0] as unknown as CommandFrame).handleEncryptionHandshake();
        }).toThrow();

        client.off('commandLegacy', sendCallback);
    });

    test('send legacy command respond raw', async () => {
        const expectedCommand = 'say';
        const expectedOverload = 'default';
        const expectedInput = { text: 'Hi there!' };
        const expectedResponse = { message: 'Yes! I am here!' };
        const requestId = randomUUID();

        const sendCallback = vi.fn((frame: LegacyCommandFrame) => {
            // #2 respond command
            client.respondCommand(frame.requestId, expectedResponse);
        });
        const recvCallback = vi.fn<(frame: CommandResponseFrame) => void>();
        client.on('commandLegacy', sendCallback);
        session.on('commandResponse', recvCallback);

        // #1 send command request raw
        session.sendCommandLegacyRaw(requestId, expectedCommand, expectedOverload, expectedInput);

        // #3 receive response
        await vi.waitFor(() => expect(recvCallback).toHaveBeenCalled());
        const response = recvCallback.mock.calls[0][0];
        expect(response.body).toEqual(expectedResponse);
        expect(response.requestId).toBe(requestId);

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandName).toBe(expectedCommand);
        expect(sendCallback.mock.calls[0][0].overload).toBe(expectedOverload);
        expect(sendCallback.mock.calls[0][0].input).toEqual(expectedInput);
        expect(sendCallback.mock.calls[0][0].requestId).toBe(requestId);

        client.off('commandLegacy', sendCallback);
        session.off('commandResponse', recvCallback);
    });

    test('subscribe event and send event raw (V1)', async () => {
        const eventName = 'TestEventName';
        const expectedFirstEventBody = { firstEvent: 1 };
        const expectedSecondEventBody = { secondEvent: 'hi' };
        const expectedThirdEventBody = { thirdEvent: true };

        const subscribeCallback = vi.fn<(frame: SubscribeFrame) => void>();
        const unsubscribeCallback = vi.fn<(frame: UnsubscribeFrame) => void>();
        const eventListener = vi.fn<(frame: EventFrame) => void>();
        const eventFilteredListener = vi.fn<(frame: EventFrame) => void>();
        client.on('subscribe', subscribeCallback);
        client.on('unsubscribe', unsubscribeCallback);
        session.on('event', eventListener);

        // #1 send event before subscribed
        client.sendEvent(eventName, expectedFirstEventBody);
        await vi.waitFor(() => expect(eventListener).toHaveBeenCalled());
        const firstEvent = eventListener.mock.calls[0][0];
        expect(firstEvent.body).toMatchObject(expectedFirstEventBody);
        expect(eventListener).toHaveBeenCalledTimes(1);

        // #2 subscribe event
        session.subscribe(eventName, eventFilteredListener);
        await vi.waitFor(() => expect(subscribeCallback).toHaveBeenCalled());
        const subscribeFrame = subscribeCallback.mock.calls[0][0];
        expect(subscribeFrame.body).toEqual({ eventName });

        // #3 send event after subscribed
        client.sendEvent(eventName, expectedSecondEventBody);
        await vi.waitFor(() => expect(eventFilteredListener).toHaveBeenCalled());
        const secondEvent = eventFilteredListener.mock.calls[0][0];
        expect(secondEvent.body).toMatchObject(expectedSecondEventBody);
        expect(eventListener).toHaveBeenCalledTimes(1);
        expect(eventFilteredListener).toHaveBeenCalledTimes(1);

        // #4 unsubscribe event
        session.unsubscribe(eventName, eventFilteredListener);
        await vi.waitFor(() => expect(unsubscribeCallback).toHaveBeenCalled());
        const unsubscribeFrame = unsubscribeCallback.mock.calls[0][0];
        expect(unsubscribeFrame.body).toEqual({ eventName });

        // #5 send event after unsubscribed
        eventListener.mockClear();
        client.sendEvent(eventName, expectedThirdEventBody);
        await vi.waitFor(() => expect(eventListener).toHaveBeenCalled());
        const thirdEvent = eventListener.mock.calls[0][0];
        expect(thirdEvent.body).toMatchObject(expectedThirdEventBody);
        expect(eventListener).toHaveBeenCalledTimes(1);
        expect(eventFilteredListener).toHaveBeenCalledTimes(1);

        client.off('subscribe', subscribeCallback);
        client.off('unsubscribe', unsubscribeCallback);
        session.off('event', eventListener);
    });

    test('subscribe event raw and publish event (V2)', async () => {
        const eventName = 'TestEventName';
        const expectedFirstEventBody = { firstEvent: 1 };
        const expectedSecondEventBody = { secondEvent: 'hi' };
        const expectedThirdEventBody = { thirdEvent: true };

        const eventListener = vi.fn<(frame: EventFrame) => void>();
        session.on('event', eventListener);

        // #1 publish event before subscribed
        client.version = Version.V1_1_0;
        client.publishEvent(eventName, expectedFirstEventBody);
        await setTimeout(100);
        expect(eventListener).toHaveBeenCalledTimes(0);

        // #2 publish event after subscribed
        session.subscribeRaw(eventName);
        await setTimeout(100);
        client.publishEvent(eventName, expectedSecondEventBody);
        await vi.waitFor(() => expect(eventListener).toHaveBeenCalled());
        const secondEvent = eventListener.mock.calls[0][0];
        expect(secondEvent.body).toMatchObject(expectedSecondEventBody);
        expect(eventListener).toHaveBeenCalledTimes(1);

        // #3 publish event after unsubscribed
        session.unsubscribeRaw(eventName);
        await setTimeout(100);
        client.publishEvent(eventName, expectedThirdEventBody);
        await setTimeout(100);
        expect(eventListener).toHaveBeenCalledTimes(1);

        session.off('event', eventListener);
    });

    test('error event', async () => {
        const errorCode = 10001;
        const errorMessage = 'This is a test error message';
        const requestId = randomUUID();

        const errorListener = vi.fn<(error: ClientError) => void>();
        session.on('clientError', errorListener);

        // #1 send error
        client.sendError(errorCode, errorMessage, requestId);

        // #2 received error
        await vi.waitFor(() => expect(errorListener).toHaveBeenCalled());
        const error = errorListener.mock.calls[0][0];
        expect(error.statusCode).toBe(errorCode);
        expect(error.statusMessage).toBe(errorMessage);
        expect(error.requestId).toBe(requestId);
        expect(error.frame.requestId).toBe(requestId);
        expect(error.message).toBe(errorMessage);

        session.off('clientError', errorListener);
    });

    test('subscribe chat', async () => {
        const steve = 'Steve';
        const alex = 'Alex';
        const chatMessageFilter = 'hello';
        const chatType = ChatEventFrameType.Say;
        const chatMessage = 'Nice to meet you';

        const chatSubscribeCallback = vi.fn<(frame: ChatSubscribeFrame) => void>();
        const chatUnsubscribeCallback = vi.fn<(frame: ChatUnsubscribeFrame) => void>();
        const chatCallback = vi.fn<(frame: ChatEventFrame) => void>();
        client.on('chatSubscribe', chatSubscribeCallback);
        client.on('chatUnsubscribe', chatUnsubscribeCallback);

        // #1 subscribe chat
        const requestId = session.subscribeChat(steve, alex, chatMessageFilter, chatCallback);
        await vi.waitFor(() => expect(chatSubscribeCallback).toHaveBeenCalled());
        const chatSubscription = chatSubscribeCallback.mock.calls[0][0];
        expect(chatSubscription.sender).toBe(steve);
        expect(chatSubscription.receiver).toBe(alex);
        expect(chatSubscription.chatMessage).toBe(chatMessageFilter);
        expect(chatSubscription.requestId).toBe(requestId);

        // #2 send chat event
        client.sendChat(requestId, chatType, alex, steve, chatMessage);
        await vi.waitFor(() => expect(chatCallback).toHaveBeenCalled());
        const chatEvent = chatCallback.mock.calls[0][0];
        expect(chatEvent.sender).toBe(alex);
        expect(chatEvent.receiver).toBe(steve);
        expect(chatEvent.chatMessage).toBe(chatMessage);
        expect(chatEvent.chatType).toBe(chatType);

        // #3 unsubscribe chat
        session.unsubscribeChat(requestId);
        await vi.waitFor(() => expect(chatUnsubscribeCallback).toHaveBeenCalled());
        const chatUnsubscription = chatUnsubscribeCallback.mock.calls[0][0];
        expect(chatUnsubscription.subscribeRequestId).toBe(requestId);

        // #4 unsubscribe chat all
        chatUnsubscribeCallback.mockClear();
        session.unsubscribeChatAll();
        await vi.waitFor(() => expect(chatUnsubscribeCallback).toHaveBeenCalled());
        const chatUnsubscriptionAll = chatUnsubscribeCallback.mock.calls[0][0];
        expect(chatUnsubscriptionAll.subscribeRequestId).toBeUndefined();

        client.off('chatSubscribe', chatSubscribeCallback);
    });

    test('send agent action and respond', async () => {
        const expectedCommand = '/agent test';
        const expectedResponse = { message: 'Yes! I am here!' };
        const expectedAgentAction = { data: 'agent action' };
        const expectedAction = MinecraftAgentActionType.Inspect;
        const expectedActionName = 'inspect';

        const sendCallback = vi.fn((frame: AgentActionFrame) => {
            // #2 respond command
            frame.respondCommand(expectedResponse);
            frame.respondAgentAction(expectedAction, expectedActionName, expectedAgentAction);
        });
        const recvCallback = vi.fn<(frame: AgentActionResponseFrame) => void>();
        client.on('agentAction', sendCallback);

        // #1 send command request
        const requestId = session.sendAgentCommand(expectedCommand, recvCallback);

        // #3 receive response
        await vi.waitFor(() => expect(recvCallback).toHaveBeenCalled());
        const response = recvCallback.mock.calls[0][0];
        expect(response.body).toEqual(expectedAgentAction);
        expect(response.action).toBe(expectedAction);
        expect(response.actionName).toBe(expectedActionName);
        expect(response.commandResponse).toBeDefined();
        expect(response.commandResponse?.body).toEqual(expectedResponse);
        expect(response.requestId).toBe(requestId);
        expect(response.commandResponse?.requestId).toBe(requestId);

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandLine).toBe(expectedCommand);
        expect(sendCallback.mock.calls[0][0].requestId).toBe(requestId);

        client.off('agentAction', sendCallback);
    });

    test('send data request and respond', async () => {
        const dataType = MinecraftDataType.Block;
        const dataResponse = [{ id: 'mcpews:test', aux: 0, name: 'mcpews test' }];

        const sendCallback = vi.fn((frame: DataRequestFrame<typeof dataType>) => {
            // #2 respond command
            frame.respond(dataResponse);
        });
        const recvCallback = vi.fn<(frame: DataFrame<typeof dataType, typeof dataResponse>) => void>();
        client.setDataResponser(dataType, sendCallback);

        // #1 send data request
        const requestId = session.fetchData(dataType, recvCallback);

        // #3 receive response
        await vi.waitFor(() => expect(recvCallback).toHaveBeenCalled());
        const response = recvCallback.mock.calls[0][0];
        expect(response.body).toEqual(dataResponse);
        expect(response.dataType).toBe(dataType);
        expect(response.requestId).toBe(requestId);

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].purpose).toBe(`data:${dataType}`);
        expect(sendCallback.mock.calls[0][0].requestId).toBe(requestId);

        client.clearDataResponser(dataType);
    });

    test('encryption by command', async () => {
        const expectedCommand = '/say This message is encrypted!';
        const expectedResponse = { message: 'Yes! It is encrypted!' };

        const handshakeResults = [] as boolean[];
        const commandCallback = vi.fn((frame: CommandFrame) => {
            // #2 handle encryption handshake
            const handshakeResult = frame.handleEncryptionHandshake();
            handshakeResults.push(handshakeResult);
            if (!handshakeResult) {
                frame.respond(expectedResponse);
            }
        });
        const encryptCallback = vi.fn<(session: ServerSession) => void>();
        const commandResponseCallback = vi.fn<(frame: CommandResponseFrame) => void>();
        client.on('command', commandCallback);

        // #1 send encryption handshake
        const encryptableBefore = session.enableEncryption(encryptCallback);
        expect(encryptableBefore).toBe(true);

        // #3 wait for handshake complete
        await vi.waitFor(() => expect(encryptCallback).toHaveBeenCalled());
        expect(session.encryption).toBeTruthy();
        expect(client.encryption).toBeTruthy();

        // #4 check encryptable and other flags
        const encryptableAfter = session.enableEncryption();
        expect(encryptableAfter).toBe(false);
        expect(session.encrypted).toBe(false); // No data transmitted, so assume it is not encrypted yet.
        expect(client.encrypted).toBe(false);
        expect(session.isEncrypted()).toBe(false);
        expect(client.isEncrypted()).toBe(false);

        // #5 transmit data
        session.sendCommand(expectedCommand, commandResponseCallback);
        await vi.waitFor(() => expect(commandResponseCallback).toHaveBeenCalled());
        const commandResponse = commandResponseCallback.mock.calls[0][0];
        expect(commandResponse.body).toEqual(expectedResponse);
        expect(session.encrypted).toBe(true);
        expect(client.encrypted).toBe(true);

        expect(commandCallback).toHaveBeenCalledTimes(2);
        expect(commandCallback.mock.calls[0][0].commandLine).toContain('enableencryption');
        expect(commandCallback.mock.calls[1][0].commandLine).toBe(expectedCommand);
        expect(handshakeResults).toEqual([true, false]);

        client.off('command', commandCallback);
    });

    test('encryption by frame (cfb8)', async () => {
        const expectedCommand = '/say This message is encrypted!';
        const expectedResponse = { message: 'Yes! It is encrypted!' };

        const handshakeResults = [] as boolean[];
        const commandCallback = vi.fn((frame: CommandFrame) => {
            // #2 handle encryption handshake
            const handshakeResult = frame.handleEncryptionHandshake();
            handshakeResults.push(handshakeResult);
            if (!handshakeResult) {
                frame.respond(expectedResponse);
            }
        });
        const encryptRequestCallback = vi.fn<(request: EncryptRequest) => void>();
        const encryptCallback = vi.fn<(session: ServerSession) => void>();
        const commandResponseCallback = vi.fn<(frame: CommandResponseFrame) => void>();
        client.on('command', commandCallback);
        client.on('encryptRequest', encryptRequestCallback);

        // #1 send encryption handshake
        session.version = Version.V1_0_0;
        const encryptableBefore = session.enableEncryption(EncryptionMode.Aes256cfb8, encryptCallback);
        expect(encryptableBefore).toBe(true);

        // #2 wait for handshake complete
        await vi.waitFor(() => expect(encryptCallback).toHaveBeenCalled());
        expect(session.encryption).toBeTruthy();
        expect(client.encryption).toBeTruthy();

        // #3 transmit data
        session.sendCommand(expectedCommand, commandResponseCallback);
        await vi.waitFor(() => expect(commandResponseCallback).toHaveBeenCalled());
        const commandResponse = commandResponseCallback.mock.calls[0][0];
        expect(commandResponse.body).toEqual(expectedResponse);
        expect(session.encrypted).toBe(true);
        expect(client.encrypted).toBe(true);

        expect(encryptRequestCallback).toHaveBeenCalledTimes(1);
        expect(() => {
            encryptRequestCallback.mock.calls[0][0].cancel();
        }).toThrow();
        expect(commandCallback).toHaveBeenCalledTimes(1);
        expect(commandCallback.mock.calls[0][0].commandLine).toEqual(expectedCommand);
        expect(handshakeResults).toEqual([false]);

        client.off('command', commandCallback);
        client.off('encryptRequest', encryptRequestCallback);
    });

    test('encryption by frame (cfb)', async () => {
        const expectedCommand = '/say This message is encrypted!';
        const expectedResponse = { message: 'Yes! It is encrypted!' };

        const handshakeResults = [] as boolean[];
        const commandCallback = vi.fn((frame: CommandFrame) => {
            // #2 handle encryption handshake
            const handshakeResult = frame.handleEncryptionHandshake();
            handshakeResults.push(handshakeResult);
            if (!handshakeResult) {
                frame.respond(expectedResponse);
            }
        });
        const encryptCallback = vi.fn<(session: ServerSession) => void>();
        const commandResponseCallback = vi.fn<(frame: CommandResponseFrame) => void>();
        client.on('command', commandCallback);

        // #1 send encryption handshake
        session.version = Version.V1_0_0;
        const encryptableBefore = session.enableEncryption(EncryptionMode.Aes256cfb, encryptCallback);
        expect(encryptableBefore).toBe(true);

        // #2 wait for handshake complete
        await vi.waitFor(() => expect(encryptCallback).toHaveBeenCalled());
        expect(session.encryption).toBeTruthy();
        expect(client.encryption).toBeTruthy();

        // #3 transmit data
        session.sendCommand(expectedCommand, commandResponseCallback);
        await vi.waitFor(() => expect(commandResponseCallback).toHaveBeenCalled());
        const commandResponse = commandResponseCallback.mock.calls[0][0];
        expect(commandResponse.body).toEqual(expectedResponse);
        expect(session.encrypted).toBe(true);
        expect(client.encrypted).toBe(true);

        expect(commandCallback).toHaveBeenCalledTimes(1);
        expect(commandCallback.mock.calls[0][0].commandLine).toBe(expectedCommand);
        expect(handshakeResults).toEqual([false]);

        client.off('command', commandCallback);
    });
});

describe('app server and client', () => {
    let app: WSApp;
    let session: AppSession;
    let client: WSClient;
    beforeEach(async () => {
        app = new WSApp(port);
        const callback = vi.fn<(connection: AppSessionConnection) => void>();
        app.once('session', callback);
        client = new WSClient(`ws://127.0.0.1:${port}`);
        await vi.waitFor(() => expect(callback).toHaveBeenCalled());
        const clientConn = callback.mock.calls[0][0];
        session = clientConn.session;
        if (session.session.socket.readyState !== WebSocket.OPEN) {
            await pEvent(session.session.socket, 'open');
        }
        if (client.socket.readyState !== WebSocket.OPEN) {
            await pEvent(client.socket, 'open');
        }
    });
    afterEach(async () => {
        await session?.disconnect(true);
        client?.disconnect();
        app.close();
    });

    test('send command and respond', async () => {
        const expectedCommand = '/say Hi, there!';
        const expectedResponse = { message: 'Yes! I am here!' };

        const sendCallback = vi.fn((frame: CommandFrame) => {
            frame.respond(expectedResponse);
        });
        client.on('command', sendCallback);

        const response = await session.command(expectedCommand);
        expect(response.body).toEqual(expectedResponse);

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandLine).toBe(expectedCommand);

        client.off('command', sendCallback);
    });

    test('send command and reject', async () => {
        const expectedCommand = '/say Hi, there!';
        const expectedError = { statusCode: 2147483648, statusMessage: 'Who are you?' };

        const sendCallback = vi.fn((frame: CommandFrame) => {
            frame.respond(expectedError);
        });
        client.on('command', sendCallback);

        let response: CommandResponseFrame | null = null;
        let responseError: Error | null = null;
        try {
            response = await session.command(expectedCommand);
        } catch (err) {
            responseError = err as Error;
        }
        expect(response).toBeNull();
        expect(responseError?.message).toEqual(expectedError.statusMessage);

        client.off('command', sendCallback);
    });

    test('send command legacy and respond', async () => {
        const expectedCommand = 'say';
        const expectedOverload = 'default';
        const expectedInput = { text: 'Hi there!' };
        const expectedResponse = { message: 'Yes! I am here!' };

        const sendCallback = vi.fn((frame: LegacyCommandFrame) => {
            frame.respond(expectedResponse);
        });
        client.on('commandLegacy', sendCallback);

        const response = await session.commandLegacy(expectedCommand, expectedOverload, expectedInput);
        expect(response.body).toEqual(expectedResponse);

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandName).toBe(expectedCommand);
        expect(sendCallback.mock.calls[0][0].overload).toBe(expectedOverload);
        expect(sendCallback.mock.calls[0][0].input).toEqual(expectedInput);

        client.off('commandLegacy', sendCallback);
    });

    test('subscribe event and unsubscribe', async () => {
        const eventName = 'TestEventName';
        const expectedEventBody = { data: ['something'] };

        const subscribeCallback = vi.fn<(frame: SubscribeFrame) => void>();
        const unsubscribeCallback = vi.fn<(frame: UnsubscribeFrame) => void>();
        const eventListener = vi.fn<(frame: EventFrame) => void>();
        client.on('subscribe', subscribeCallback);
        client.on('unsubscribe', unsubscribeCallback);

        // #1 subscribe event
        session.on(eventName, eventListener);
        await vi.waitFor(() => expect(subscribeCallback).toHaveBeenCalled());
        const subscribeFrame = subscribeCallback.mock.calls[0][0];
        expect(subscribeFrame.body).toEqual({ eventName });

        // #2 send event after subscribed
        client.sendEvent(eventName, expectedEventBody);
        await vi.waitFor(() => expect(eventListener).toHaveBeenCalled());
        const event = eventListener.mock.calls[0][0];
        expect(event.body).toMatchObject(expectedEventBody);

        // #3 unsubscribe event
        session.off(eventName, eventListener);
        await vi.waitFor(() => expect(unsubscribeCallback).toHaveBeenCalled());
        const unsubscribeFrame = unsubscribeCallback.mock.calls[0][0];
        expect(unsubscribeFrame.body).toEqual({ eventName });
        expect(eventListener).toHaveBeenCalledTimes(1);

        client.off('subscribe', subscribeCallback);
        client.off('unsubscribe', unsubscribeCallback);
    });

    test('wait for event', async () => {
        const eventName = 'TestEventName';
        const expectedEventBody = { data: 'else' };

        const eventPromise = session.waitForEvent(eventName);
        await setTimeout(100); // wait for subscription
        client.publishEvent(eventName, expectedEventBody);

        const event = await eventPromise;
        expect(event.body).toMatchObject(expectedEventBody);
    });

    test('once event', async () => {
        const eventName = 'TestEventName';
        const expectedEventBody = { data: 'once' };

        const eventListener = vi.fn<(frame: EventFrame) => void>();
        session.once(eventName, eventListener);
        await setTimeout(100); // wait for subscription
        client.publishEvent(eventName, expectedEventBody);
        client.publishEvent(eventName, expectedEventBody);
        await setTimeout(100); // wait for event publishing

        const eventPromise = session.waitForEvent(eventName);
        await setTimeout(100); // wait for subscription
        client.publishEvent(eventName, expectedEventBody);
        await eventPromise;
        expect(eventListener).toHaveBeenCalledTimes(1);
        expect(eventListener.mock.calls[0][0].body).toMatchObject(expectedEventBody);
    });

    test('encryption', async () => {
        const expectedCommand = '/say Hi, there!';
        const expectedResponse = { message: 'Yes! I am here!' };

        const sendCallback = vi.fn((frame: CommandFrame) => {
            if (!frame.handleEncryptionHandshake()) {
                frame.respond(expectedResponse);
            }
        });
        client.on('command', sendCallback);

        expect(session.session.encryption).toBeNull();
        expect(client.encryption).toBeNull();
        expect(session.isEncrypted()).toBe(false);

        await session.enableEncryption();
        expect(session.session.encryption).not.toBeNull();
        expect(client.encryption).not.toBeNull();
        expect(session.isEncrypted()).toBe(false);

        const response = await session.command(expectedCommand);
        expect(response.body).toEqual(expectedResponse);
        expect(session.isEncrypted()).toBe(true);

        expect(sendCallback).toHaveBeenCalledTimes(2);
        expect(sendCallback.mock.calls[1][0].commandLine).toBe(expectedCommand);

        client.off('command', sendCallback);
    });
});

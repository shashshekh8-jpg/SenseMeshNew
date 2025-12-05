require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = process.env.PORT || 5000;
const AI_URL = process.env.AI_SERVICE_URL || "http://localhost:7860";

const activeUsers = new Map();

app.get('/', (req, res) => res.send('SenseMesh Orchestrator Active'));

async function senseFuseProcess(senderId, receiverId, content, contentType) {
    const receiver = activeUsers.get(receiverId);
    if (!receiver) return { content, type: contentType };
    const disability = receiver.disability;

    if (contentType === 'audio') {
        try {
            const transResponse = await axios.post(`${AI_URL}/transcribe`, { data_base64: content });
            const text = transResponse.data.text;
            let emotionTag = "";
            try {
                const emoResponse = await axios.post(`${AI_URL}/analyze_text`, { text: text });
                emotionTag = `[${emoResponse.data.emotion.toUpperCase()}]`;
            } catch (e) { emotionTag = ""; }

            const finalMsg = `${text} ${emotionTag}`;
            if (disability === 'deaf') {
                return { content: finalMsg, type: 'text', meta: { original_audio: true } };
            }
            return { content, type: 'audio', meta: { transcription: finalMsg } };
        } catch (e) { return { content: "Audio Error", type: 'text' }; }
    }

    if (disability === 'blind' && contentType === 'image') {
        try {
            const response = await axios.post(`${AI_URL}/describe`, { data_base64: content });
            return { content: response.data.description, type: 'audio_synthesis_request' };
        } catch (e) { return { content: "Image Error", type: 'text' }; }
    }

    if (contentType === 'text') {
        try {
            if (content.length > 2) {
                const aiRes = await axios.post(`${AI_URL}/analyze_text`, { text: content });
                const emotion = aiRes.data.emotion;
                if (disability === 'blind') {
                    const narrated = `${content}. The tone is ${emotion}.`;
                    return { content: narrated, type: 'text', meta: { auto_read: true } };
                }
                return { content: content, type: 'text' };
            }
        } catch (e) {}
    }
    return { content, type: contentType };
}

io.on('connection', (socket) => {
    socket.on('join_mesh', (u) => {
        activeUsers.set(socket.id, u);
        io.emit('network_update', Array.from(activeUsers.entries()));
    });
    socket.on('send_message', async (payload) => {
        const { targetSocketId, content, type } = payload;
        const processed = await senseFuseProcess(socket.id, targetSocketId, content, type);
        io.to(targetSocketId).emit('receive_message', {
            senderId: socket.id, ...processed, timestamp: new Date().toISOString()
        });
    });
    socket.on('analyze_gesture_landmarks', async (landmarks) => {
        try {
            const response = await axios.post(`${AI_URL}/predict_sign`, { landmarks });
            const letter = response.data.gesture;
            if (letter === "..." || letter === "Unknown") return;
            socket.emit('receive_message', { senderId: 'AI', content: `You signed: ${letter}`, type: 'text' });
            socket.broadcast.emit('receive_message', { senderId: socket.id, content: `[ASL]: ${letter}`, type: 'text' });
        } catch (e) { console.log("ASL Error"); }
    });
    socket.on('analyze_environment', async (audioBase64) => {
        try {
            const response = await axios.post(`${AI_URL}/detect_hazard`, { data_base64: audioBase64 });
            if (response.data.urgency === 'critical') {
                io.emit('receive_message', { senderId: 'AI', content: ` ⚠️  HAZARD DETECTED: ${response.data.event.toUpperCase()}`, type: 'hazard' });
            }
        } catch (e) {}
    });
    socket.on('disconnect', () => {
        activeUsers.delete(socket.id);
        io.emit('network_update', Array.from(activeUsers.entries()));
    });
});
server.listen(PORT, () => console.log(`Server on ${PORT}`));

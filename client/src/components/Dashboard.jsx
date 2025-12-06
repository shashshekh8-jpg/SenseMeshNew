import { useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import Webcam from "react-webcam";
import { FilesetResolver, HolisticLandmarker } from "@mediapipe/tasks-vision";

const BACKEND_URL = window._env_?.VITE_BACKEND_URL || import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";
const SEQUENCE_LENGTH = 30;

export default function Dashboard({ userProfile }) {
  const [socket, setSocket] = useState(null);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [selectedTarget, setSelectedTarget] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState("");
  const [visionModel, setVisionModel] = useState(null);
  const [detectedSign, setDetectedSign] = useState("Initializing...");
  const [framesBuffer, setFramesBuffer] = useState(0); 
  const [isRecording, setIsRecording] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isHazard, setIsHazard] = useState(false);
  
  const webcamRef = useRef(null);
  const messagesEndRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const hazardTimeoutRef = useRef(null);
  const frameBufferRef = useRef([]); 
  const lastSentTime = useRef(0);

  // --- 1. SOCKET CONNECTION & MESSAGING ---
  useEffect(() => {
    const newSocket = io(BACKEND_URL);
    setSocket(newSocket);

    // Initial Join
    newSocket.on("connect", () => {
        console.log("Connected to Mesh");
        newSocket.emit("join_mesh", userProfile);
    });

    // FIX: Auto-reconnect logic to keep you visible if server restarts
    newSocket.io.on("reconnect", () => {
        console.log("Reconnected to Mesh");
        newSocket.emit("join_mesh", userProfile);
    });

    newSocket.on("network_update", (users) => {
      setOnlineUsers(users);
      const others = users.filter((u) => u[0] !== newSocket.id);
      if (others.length > 0) setSelectedTarget((prev) => prev || others[0][0]);
    });

    newSocket.on("receive_message", (msg) => {
      // FIX: Capture AI Sign Language translation for the green label
      if (msg.senderId === 'AI' && msg.content.startsWith("You signed:")) {
          setDetectedSign(msg.content.replace("You signed: ", ""));
      }

      setMessages((prev) => [...prev, msg]);

      // Audio & Accessibility Logic
      if (userProfile.disability === "blind" || msg.type === "audio_synthesis_request" || msg.meta?.auto_read) {
        if ("speechSynthesis" in window) {
            const utterance = new SpeechSynthesisUtterance(msg.content);
            window.speechSynthesis.speak(utterance);
        }
      }

      if (msg.type === "hazard") {
        setIsHazard(true);
        if ("speechSynthesis" in window) {
            const alertMsg = new SpeechSynthesisUtterance("Danger. " + msg.content);
            window.speechSynthesis.speak(alertMsg);
        }
        if (hazardTimeoutRef.current) clearTimeout(hazardTimeoutRef.current);
        hazardTimeoutRef.current = setTimeout(() => setIsHazard(false), 5000);
      }
    });

    return () => newSocket.close();
  }, [userProfile]);

  // --- 2. VISION MODEL SETUP (ASL) ---
  useEffect(() => {
    const load = async () => {
      try {
        // FIX: Use '@latest' to match your installed package version
        const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm");
        
        const landmarker = await HolisticLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/1/holistic_landmarker.task",
              delegate: "GPU",
            },
            runningMode: "VIDEO",
            minPoseDetectionConfidence: 0.5,
            minHandDetectionConfidence: 0.5,
        });
        setVisionModel(landmarker);
        setDetectedSign("ASL Ready");
      } catch (e) { 
          console.error("Vision Load Error:", e);
          setDetectedSign("Model Error");
      }
    };
    load();
  }, []);

  // --- 3. VISION LOOP ---
  useEffect(() => {
    if (!visionModel || !socket) return;
    const interval = setInterval(() => {
      const video = webcamRef.current?.video;
      if (!video || video.readyState < 2) return;
      try {
        const results = visionModel.detectForVideo(video, Date.now());
        const extract = (landmarks, count) => (landmarks ? landmarks.flatMap(p => [p.x, p.y]) : new Array(count * 2).fill(0));
        const features = [...extract(results.poseLandmarks, 33), ...extract(results.leftHandLandmarks?.[0], 21), ...extract(results.rightHandLandmarks?.[0], 21)];
 
        if (features.length !== 150) return;

        frameBufferRef.current.push(features);
        if (frameBufferRef.current.length > SEQUENCE_LENGTH) frameBufferRef.current.shift();
        setFramesBuffer(frameBufferRef.current.length);

        // Send data when buffer is full (every 1s)
        if (frameBufferRef.current.length === SEQUENCE_LENGTH && Date.now() - lastSentTime.current > 1000) {
            socket.emit("analyze_gesture_landmarks", frameBufferRef.current.flat());
            lastSentTime.current = Date.now();
            setDetectedSign("Scanning...");
        }
      } catch (e) {}
    }, 50);
    return () => clearInterval(interval);
  }, [visionModel, socket]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // --- 4. AUDIO & HAZARD UTILS ---
  const scanEnvironment = async () => {
    setIsScanning(true);
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        const chunks = [];
        recorder.ondataavailable = (e) => chunks.push(e.data);
        recorder.onstop = () => {
            const blob = new Blob(chunks, { type: "audio/webm" });
            const reader = new FileReader();
            reader.onloadend = () => socket.emit("analyze_environment", reader.result);
            reader.readAsDataURL(blob);
            stream.getTracks().forEach(t => t.stop());
            setIsScanning(false);
        };
        recorder.start();
        setTimeout(() => recorder.stop(), 10000); // 10s Scan
    } catch (e) { setIsScanning(false); }
  };

  const startRecording = async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        mediaRecorderRef.current = recorder;
        const chunks = [];
        recorder.ondataavailable = (e) => chunks.push(e.data);
        recorder.onstop = () => {
            const blob = new Blob(chunks, { type: "audio/webm" });
            const reader = new FileReader();
            reader.onloadend = () => {
                socket.emit("send_message", { targetSocketId: selectedTarget, content: reader.result, type: "audio" });
                setMessages(p => [...p, { senderId: "me", content: reader.result, type: "audio" }]);
            };
            reader.readAsDataURL(blob);
            stream.getTracks().forEach(t => t.stop());
        };
        recorder.start();
        setIsRecording(true);
    } catch (e) {}
  };
  
  const stopRecording = () => { 
      if(mediaRecorderRef.current) mediaRecorderRef.current.stop(); 
      setIsRecording(false); 
  };

  // Keyboard Shortcuts (Space to Talk)
  useEffect(() => {
    const handleDown = (e) => { if (e.code === "Space" && !["INPUT"].includes(document.activeElement.tagName)) startRecording(); };
    const handleUp = (e) => { if (e.code === "Space" && !["INPUT"].includes(document.activeElement.tagName)) stopRecording(); };
    window.addEventListener("keydown", handleDown); window.addEventListener("keyup", handleUp);
    return () => { window.removeEventListener("keydown", handleDown); window.removeEventListener("keyup", handleUp); };
  });

  return (
    <div className={`min-h-screen ${isHazard ? "bg-red-900" : "bg-slate-900"} text-white transition-colors`}>
       {isHazard && <div className="fixed inset-0 bg-red-600/90 z-50 flex items-center justify-center text-6xl font-bold animate-pulse">DANGER DETECTED</div>}
       
       <div className="max-w-6xl mx-auto p-4">
         <header className="flex justify-between mb-4">
           <h1 className="text-2xl font-bold">SenseMesh Pro</h1>
           <button onClick={scanEnvironment} disabled={isScanning} className="px-4 py-2 border border-red-500 text-red-400 rounded">
             {isScanning ? "Scanning (10s)..." : "Scan Hazards"}
           </button>
         </header>

         <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
           {/* LEFT PANEL: Users & Camera */}
           <div className="col-span-1 space-y-4">
             <div className="bg-slate-800 p-4 rounded h-64 overflow-auto">
               <h3 className="font-bold mb-2">Users</h3>
               {onlineUsers.map(([id, u]) => (
                 <div key={id} onClick={() => id !== socket.id && setSelectedTarget(id)} 
                      className={`p-2 rounded cursor-pointer ${id === selectedTarget ? "bg-indigo-600" : ""}`}>
                   {u.name} ({u.disability}) {id === socket.id && "(You)"}
                 </div>
               ))}
             </div>
             
             <div className="bg-slate-800 p-4 rounded">
               <Webcam ref={webcamRef} className="w-full rounded bg-black" />
               <p className="mt-2 text-sm">ASL: <span className="text-green-400 font-mono text-lg font-bold">{detectedSign}</span> (Buffer: {framesBuffer}/30)</p>
             </div>
           </div>

           {/* RIGHT PANEL: Chat */}
           <div className="col-span-2 bg-slate-800 rounded flex flex-col h-[600px]">
             <div className="flex-1 overflow-auto p-4 space-y-2">
               {messages.map((m, i) => (
                 <div key={i} className={`p-2 rounded max-w-xs ${m.senderId === "me" ? "ml-auto bg-indigo-600" : "bg-slate-700"}`}>
                   <p className="text-xs opacity-75">{m.senderId === "me" ? "You" : "User"}</p>
                   
                   {/* FIX: Render Audio Player for Voice Notes */}
                   {m.type === 'audio' ? (
                       <div className="space-y-1">
                           <audio controls src={m.content} className="w-full h-8 mt-1" />
                           {m.meta?.transcription && <p className="text-xs italic text-gray-300">{m.meta.transcription}</p>}
                       </div>
                   ) : (
                       <p>{m.content}</p>
                   )}

                 </div>
               ))}
               <div ref={messagesEndRef}></div>
             </div>
             
             <div className="p-4 border-t border-slate-700 flex gap-2">
               <input className="flex-1 bg-slate-900 p-2 rounded" 
                      value={inputText} 
                      onChange={e => setInputText(e.target.value)} 
                      onKeyDown={e => e.key==="Enter" && (socket.emit("send_message", {targetSocketId: selectedTarget, content: inputText, type: "text"}), setMessages(p=>[...p, {senderId: "me", content: inputText, type: "text"}]), setInputText(""))} />
               <button onClick={() => {socket.emit("send_message", {targetSocketId: selectedTarget, content: inputText, type: "text"}); setMessages(p=>[...p, {senderId: "me", content: inputText, type: "text"}]); setInputText("")}} className="bg-indigo-600 px-4 py-2 rounded">Send</button>
             </div>
           </div>
         </div>
       </div>
    </div>
  );
}
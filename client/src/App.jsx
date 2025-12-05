import { useState } from "react";
import Dashboard from "./components/Dashboard";
const disabilities = [
  { value: "deaf", label: "Deaf / Hard of Hearing" },
  { value: "blind", label: "Blind / Low Vision" },
  { value: "mute", label: "Mute / Non-Verbal" },
  { value: "none", label: "None / Ally" },
];
export default function App() {
  const [userProfile, setUserProfile] = useState(null);
  const [name, setName] = useState("");
  const [disability, setDisability] = useState("deaf");
  const handleJoin = () => {
    const finalName = name.trim() || "Guest";
    setUserProfile({ name: finalName, disability });
    if (disability === "blind" && "speechSynthesis" in window) {
      const msg = new SpeechSynthesisUtterance(`Welcome ${finalName}. Press and hold the space bar to speak.`);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(msg);
    }
  };
  if (!userProfile) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900 text-slate-100">
        <div className="bg-slate-800 p-8 rounded-2xl shadow-xl w-full max-w-md space-y-6">
          <h1 className="text-2xl font-bold text-center">SenseMesh Pro</h1>
          <div className="space-y-3">
            <label className="block text-sm font-medium text-slate-300">Your Name</label>
            <input className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-600"
              value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter your name" />
          </div>
          <div className="space-y-3">
            <label className="block text-sm font-medium text-slate-300">Accessibility Mode</label>
            <select className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-600"
              value={disability} onChange={(e) => setDisability(e.target.value)}>
              {disabilities.map((d) => (<option key={d.value} value={d.value}>{d.label}</option>))}
            </select>
          </div>
          <button onClick={handleJoin} className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 font-semibold">Join SenseMesh</button>
        </div>
      </div>
    );
  }
  return <Dashboard userProfile={userProfile} />;
}

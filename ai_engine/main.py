import os
import io
import base64
import uuid
import pickle
import numpy as np
import torch
import torch.nn as nn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List
from transformers import pipeline
from PIL import Image

try:
    import magic
    MAGIC_AVAILABLE = True
except ImportError:
    print(" ⚠️  python-magic not found. Defaulting to WAV extension.")
    MAGIC_AVAILABLE = False

app = FastAPI(title="SenseMesh AI Engine")

# 1. MODEL DEFINITION
class ASLModel(nn.Module):
    def __init__(self, num_classes):
        super().__init__()
        self.lstm = nn.LSTM(150, 128, num_layers=2, batch_first=True, dropout=0.3, bidirectional=True)
        self.fc = nn.Linear(256, num_classes)

    def forward(self, x):
        out, _ = self.lstm(x)
        return self.fc(out[:, -1, :])

# 2. LOAD RESOURCES
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
asl_model = None
asl_meta = {}

if os.path.exists("label_map.pkl") and os.path.exists("asl_model.pt"):
    try:
        with open("label_map.pkl", "rb") as f:
            asl_meta = pickle.load(f)
        
        num_classes = len(asl_meta["idx_to_label"])
        print(f"Loading ASL Model for {num_classes} words...")
        
        asl_model = ASLModel(num_classes=num_classes)
        asl_model.load_state_dict(torch.load("asl_model.pt", map_location=device))
        asl_model.to(device).eval()
        print(" ✅  ASL LSTM Model Loaded Successfully.")
    except Exception as e:
        print(f" ❌  ASL Load Fail: {e}")
else:
    print(" ⚠️  ASL Files Missing (asl_model.pt or label_map.pkl). Sign Language disabled.")

# 3. LOAD MODELS
print("Loading Core AI Models...")
try:
    sentiment_pipe = pipeline("text-classification", model="j-hartmann/emotion-english-distilroberta-base", top_k=1)
    transcribe_pipe = pipeline("automatic-speech-recognition", model="openai/whisper-tiny")
    hazard_pipe = pipeline("audio-classification", model="mit/ast-finetuned-audioset-10-10-0.4593")
    caption_pipe = pipeline("image-to-text", model="nlpconnect/vit-gpt2-image-captioning")
    print(" ✅  All Core Models Loaded.")
except Exception as e:
    print(f" ⚠️  Core Model Load Warning: {e}")

class Payload(BaseModel):
    data_base64: str = ""
    text: str = ""

class LandmarkPayload(BaseModel):
    landmarks: List[float]

def save_audio_smartly(base64_string):
    try:
        b64_clean = base64_string.split(",")[1] if "," in base64_string else base64_string
        data = base64.b64decode(b64_clean)
        ext = ".wav"
        if MAGIC_AVAILABLE:
            try:
                mime = magic.from_buffer(data, mime=True)
                if "webm" in mime: ext = ".webm"
                elif "ogg" in mime: ext = ".ogg"
                elif "mp4" in mime: ext = ".m4a"
            except: pass
        filename = f"/tmp/{uuid.uuid4()}{ext}"
        with open(filename, "wb") as f:
            f.write(data)
        return filename
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Audio Decode Error: {str(e)}")

@app.get("/")
def health_check():
    return {"status": "online", "gpu": torch.cuda.is_available(), "asl_active": asl_model is not None}

@app.post("/analyze_text")
def analyze_text(payload: Payload):
    res = sentiment_pipe(payload.text)
    return {"emotion": res[0][0]['label']}

@app.post("/transcribe")
def transcribe(payload: Payload):
    filename = None
    try:
        filename = save_audio_smartly(payload.data_base64)
        result = transcribe_pipe(filename)
        return {"text": result["text"]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if filename and os.path.exists(filename): os.remove(filename)

@app.post("/detect_hazard")
def detect_hazard(payload: Payload):
    filename = None
    try:
        filename = save_audio_smartly(payload.data_base64)
        events = hazard_pipe(filename, top_k=5)
        dangers = ["siren", "alarm", "scream", "explosion", "glass", "gunshot", "fire"]
        top_event = events[0]['label']
        is_dangerous = any(d in e['label'].lower() for e in events for d in dangers)
        urgency_level = "critical" if is_dangerous else "low"
        return {"event": top_event, "urgency": urgency_level}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if filename and os.path.exists(filename): os.remove(filename)

@app.post("/describe")
def describe_image(payload: Payload):
    try:
        b64_str = payload.data_base64.split(",")[1] if "," in payload.data_base64 else payload.data_base64
        image_data = base64.b64decode(b64_str)
        image = Image.open(io.BytesIO(image_data))
        captions = caption_pipe(image)
        return {"description": captions[0]["generated_text"]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/predict_sign")
def predict_sign(payload: LandmarkPayload):
    if not asl_model: return {"gesture": "Error: Model Missing"}
    try:
        raw_data = np.array(payload.landmarks, dtype=np.float32)
        if raw_data.size != 30 * 150:
            return {"gesture": "Shape Error"}
        
        # NORMALIZE
        norm_data = (raw_data - asl_meta["mean"]) / (asl_meta["std"] + 1e-7)
        input_tensor = torch.tensor(norm_data).reshape(1, 30, 150).to(device)
        
        with torch.no_grad():
            logits = asl_model(input_tensor)
            idx = torch.argmax(logits, dim=1).item()
            confidence = torch.softmax(logits, dim=1)[0, idx].item()

        label = asl_meta["idx_to_label"][idx]
        if confidence < 0.7: return {"gesture": "..."} 
        return {"gesture": str(label)}
    except Exception as e:
        print("❌ ASL Prediction Error:", e)
        return {"gesture": "Error"}

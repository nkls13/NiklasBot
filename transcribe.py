import sys
import whisper
import os

if len(sys.argv) < 2:
    print("Please provide a path to the audio file.")
    sys.exit(1)

audio_path = sys.argv[1]

if not os.path.exists(audio_path):
    print(f"File not found: {audio_path}")
    sys.exit(1)

try:
    model = whisper.load_model("base")  # You can also try "small" or "medium" if needed
    result = model.transcribe(audio_path)
    print(result["text"])
except Exception as e:
    print(f"Error transcribing: {e}")

FROM python:3.9-slim

WORKDIR /code

# Install system audio libraries
RUN apt-get update && apt-get install -y ffmpeg libsndfile1 libmagic1 && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY ./requirements.txt /code/requirements.txt
RUN pip install --no-cache-dir --upgrade -r /code/requirements.txt

# Copy all project files
COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]

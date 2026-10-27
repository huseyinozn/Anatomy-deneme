# Slicing service for the Quadro 3D page: OrcaSlicer 2.4.2 (linuxserver image) + the Co Print profiles + server.py.
# Build:  docker build -t quadro-slicer .      Run:  docker run -p 8080:8080 quadro-slicer
FROM linuxserver/orcaslicer:latest
COPY . /app
ENV DATA=/data PORT=8080 PYTHONUNBUFFERED=1
# flatten the presets and export the project templates now, so a new instance starts serving at once
RUN /lsiopy/bin/python3 /app/server.py --prepare
EXPOSE 8080
ENTRYPOINT ["/lsiopy/bin/python3", "/app/server.py"]

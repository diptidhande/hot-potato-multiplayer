# 🔥 Hot Potato — Multiplayer Browser Game

A small, real-time, room-based multiplayer game for 2–8 players.

## Rules
1. The player holding 🥔 has 12 seconds.
2. They can pass the potato to another living player or attempt a quick task.
3. A successful task keeps the potato with the current player; they can then pass or attempt another task.
4. If the timer expires while a player holds the potato, they take a strike.
5. A failed quick task also gives the holder a strike.
6. Three strikes eliminates a player.
7. The last living player wins.

## Run locally

```bash
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

Open `http://localhost:3000`.

For two devices on the same LAN, open `http://YOUR-COMPUTER-IP:3000` on both devices.

## Deployment

The server is designed for a WebSocket-capable Python host such as Render. It serves the frontend and WebSocket endpoint from the same public URL.

Start command:

```bash
python server.py
```

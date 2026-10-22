#!/bin/bash
echo "====================================================="
echo "   DocStudio Word Pro - Open-Source Office Suite    "
echo "====================================================="
echo "[*] Starting local offline server..."

# Check if python virtualenv exists
if [ -d "/mnt/c/Users/keysh/github/.venv" ]; then
    echo "[*] Launching high-fidelity conversion engine in background..."
    /mnt/c/Users/keysh/github/.venv/bin/python3 converter_server.py &
    ENGINE_PID=$!
fi

echo "[*] Launching DocStudio Office..."
npx vite --host 0.0.0.0 --port 5173

# Cleanup
if [ ! -z "$ENGINE_PID" ]; then
    kill $ENGINE_PID 2>/dev/null
fi

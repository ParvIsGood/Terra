import sys
import asyncio
import edge_tts

async def main():
    if len(sys.argv) < 2:
        return
    text = sys.argv[1]
    voice = sys.argv[2] if len(sys.argv) > 2 else "hi-IN-MadhurNeural"
    rate = sys.argv[3] if len(sys.argv) > 3 else "+0%"

    try:
        tts = edge_tts.Communicate(text, voice, rate=rate)
        async for chunk in tts.stream():
            if chunk["type"] == "audio":
                sys.stdout.buffer.write(chunk["data"])
    except Exception as e:
        sys.stderr.write(f"Edge TTS error: {e}\n")

if __name__ == "__main__":
    asyncio.run(main())

# SPDX-License-Identifier: Apache-2.0
# Model input vocabulary and inference recipe adapted from KittenML/KittenTTS 0.8
# https://github.com/KittenML/KittenTTS/blob/0.8/kittentts/onnx_model.py
# Requires numpy, onnxruntime, soundfile and the optional npm kokoro-js install.
# Usage: python tools/render-kitten-voice.py
import json
from pathlib import Path
import re
import subprocess
import time
import urllib.request

import numpy as np
import onnxruntime as ort
import soundfile as sf


def main():
    root = Path(__file__).resolve().parents[1]
    cache = root / 'download' / 'voices' / 'kitten-nano-0.8-int8'
    output = root / 'demo-output' / 'neural-voice'
    cache.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    base = 'https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8/resolve/main/'
    for name in ['config.json', 'kitten_tts_nano_v0_8.onnx', 'voices.npz']:
        target = cache / name
        if not target.exists():
            print(f'Downloading {name}', flush=True)
            # A failed download must never look like a complete cached file.
            temporary = target.with_suffix(target.suffix + '.partial')
            urllib.request.urlretrieve(base + name, temporary)
            temporary.replace(target)
    config = json.loads((cache / 'config.json').read_text())
    text = 'Welcome to the village. Watch out, the guardian is coming!'
    # Reuse the same eSpeak-NG phonemizer as kokoro-js; text travels as JSON data.
    script = """
import { phonemize } from 'phonemizer';
let input = ''; for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify(await phonemize(JSON.parse(input), 'en-us')));
"""
    result = subprocess.run(['node', '--input-type=module', '-e', script],
                            input=json.dumps(text), text=True, capture_output=True,
                            check=True, cwd=root, encoding='utf-8')
    phonemes = ' '.join(json.loads(result.stdout))
    phonemes = ' '.join(re.findall(r'\w+|[^\w\s]', phonemes))
    # Exact symbol order is part of the released model's token-id contract.
    punctuation = ';:,.!?¡¿—…"«»"" '
    letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    ipa = "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'̩'ᵻ"
    vocabulary = {symbol: i for i, symbol in enumerate('$' + punctuation + letters + ipa)}
    tokens = [0] + [vocabulary[c] for c in phonemes if c in vocabulary] + [0]
    voices = np.load(cache / 'voices.npz', allow_pickle=False)
    session = ort.InferenceSession(str(cache / config['model_file']), providers=['CPUExecutionProvider'])
    report = []
    for name in ['Bella', 'Jasper']:
        voice = config['voice_aliases'][name]
        style_index = min(len(text), voices[voice].shape[0] - 1)
        started = time.perf_counter()
        samples = session.run(None, {
            'input_ids': np.array([tokens], dtype=np.int64),
            'style': voices[voice][style_index:style_index + 1],
            'speed': np.array([config['speed_priors'][voice]], dtype=np.float32),
        })[0][..., :-5000].reshape(-1)
        elapsed = time.perf_counter() - started
        if not len(samples) or not np.isfinite(samples).all():
            raise ValueError('Kitten produced invalid audio')
        sf.write(output / f'kitten-{name.lower()}.wav', samples, 24000)
        entry = dict(voice=name, text=text, seconds=len(samples) / 24000,
                     generationSeconds=elapsed)
        report.append(entry)
        print(json.dumps(entry), flush=True)
    (output / 'kitten-results.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()

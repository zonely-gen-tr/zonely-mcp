"""Offline model worker. JSON-lines stdout only; library logs go to stderr."""
import contextlib
import json
import os
import sys
import traceback
from collections import deque, OrderedDict
from pathlib import Path

os.environ.setdefault('TRANSLATE_DEVICE', 'cpu')
os.environ.setdefault('FLAGS_use_mkldnn', '0')
os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK', 'True')
os.environ.setdefault('PADDLE_PDX_DISABLE_DEV_MODEL_WL', 'True')
MODELS = OrderedDict()
ENGINES = {}
PACKAGES = None


def packages():
    global PACKAGES
    if PACKAGES is None:
        from argostranslate.package import get_installed_packages
        PACKAGES = {(p.from_code, p.to_code): p for p in get_installed_packages()}
    return PACKAGES


def route(source, target):
    source = {'pt': 'pb', 'pt_BR': 'pb', 'zh_CN': 'zh'}.get(source, source.split('_')[0])
    target = {'pt': 'pb', 'pt_BR': 'pb', 'zh_CN': 'zh'}.get(target, target.split('_')[0])
    queue = deque([(source, [])])
    seen = {source}
    while queue:
        current, steps = queue.popleft()
        if current == target:
            return steps
        for pair in packages():
            if pair[0] == current and pair[1] not in seen:
                seen.add(pair[1])
                queue.append((pair[1], steps + [pair]))
    raise ValueError(f'No installed Argos route: {source} -> {target}')


def translate(texts, source, target):
    import ctranslate2
    steps = route(source, target)
    values = list(texts)
    for pair in steps:
        pkg = packages()[pair]
        if pair not in MODELS:
            if len(MODELS) >= 3:
                MODELS.popitem(last=False)
            MODELS[pair] = ctranslate2.Translator(str(pkg.package_path / 'model'), device='cpu',
                                                 compute_type='int8', inter_threads=1,
                                                 intra_threads=min(4, os.cpu_count() or 2))
        MODELS.move_to_end(pair)
        active = [i for i, t in enumerate(values) if t.strip()]
        if not active:
            continue
        tokens = [pkg.tokenizer.encode(values[i]) for i in active]
        
        results = MODELS[pair].translate_batch(tokens, target_prefix=[[pkg.target_prefix] for _ in tokens] if pkg.target_prefix else None,
            replace_unknowns=True, max_batch_size=32, beam_size=2, max_input_length=0,
            max_decoding_length=max(256, max(map(len, tokens)) * 3 + 32))
        for i, result in zip(active, results):
            value = pkg.tokenizer.decode(result.hypotheses[0])
            if pkg.target_prefix and value.startswith(pkg.target_prefix):
                value = value[len(pkg.target_prefix):]
            if not value.strip():
                raise ValueError('Argos produced empty output; source was not labelled as translated')
            values[i] = value.strip()
    return {'texts': values, 'route': [list(p) for p in steps], 'engine': 'Argos/CTranslate2', 'review': 'machine-needs-review'}


def ocr(filename, locale):
    from paddleocr import PaddleOCR
    from PIL import Image
    
    lang = locale.split('_')[0]
    group = lang if lang in ('ru', 'hi') else 'tr'
    if group not in ENGINES:
        ENGINES[group] = PaddleOCR(lang=group, use_doc_orientation_classify=False,
            use_doc_unwarping=False, use_textline_orientation=False, enable_mkldnn=False,
            text_rec_score_thresh=0.35)
    predicted = list(ENGINES[group].predict(filename))
    result = predicted[0] if predicted else {}
    regions = []
    for text, score, poly in zip(result.get('rec_texts', []), result.get('rec_scores', []), result.get('rec_polys', [])):
        if not str(text).strip() or float(score) < 0.7:
            continue
        points = poly.tolist() if hasattr(poly, 'tolist') else poly
        xs, ys = [float(p[0]) for p in points], [float(p[1]) for p in points]
        regions.append({'originalText': str(text).strip(), 'text': str(text).strip(),
            'confidence': round(float(score)*100), 'bbox': {'x0': round(min(xs)), 'y0': round(min(ys)), 'x1': round(max(xs)), 'y1': round(max(ys))},
            'polygon': [[round(float(x)),round(float(y))] for x,y in points]})
    regions.sort(key=lambda r:(r['bbox']['y0'],r['bbox']['x0']))
    for i,r in enumerate(regions):
        r['id'] = f'text_{i+1:03}'
    with Image.open(filename) as im:
        width,height = im.size
    return {'regions':regions,'image':{'width':width,'height':height},'engine':'PaddleOCR',
            'modelGroup':group, 'locale':locale, 'review':'machine-extracted-needs-review'}


def dispatch(data):
    if data['action'] == 'status':
        return {'routes':[list(pair) for pair in packages()], 'engine':'Argos/CTranslate2', 'ocr':'PaddleOCR'}
    if data['action'] == 'translate':
        return translate(data['texts'], data['source'], data['target'])
    if data['action'] == 'ocr':
        return ocr(data['path'], data['locale'])
    raise ValueError('Unknown worker action')


for line in sys.stdin:
    try:
        message = json.loads(line)
        with contextlib.redirect_stdout(sys.stderr):
            result = dispatch(message)
        response = {'id':message['id'], 'result':result}
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        response = {'id':message.get('id') if 'message' in globals() else None, 'error':str(exc)}
    print(json.dumps(response,ensure_ascii=False),flush=True)

"""Explicit installer for the bundled worker's model dependencies; no website access."""
import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--install-models', action='store_true')
parser.add_argument('--install-ocr', action='store_true')
args = parser.parse_args()
from argostranslate import package

targets = ['tr','en','cs','de','es','fr','hi','hu','it','ja','nb','nl','pb','pl','ro','ru','sv','vi','zh']
required = [('tr','en')] + [('en', t) for t in targets if t != 'en']
installed = {(p.from_code,p.to_code) for p in package.get_installed_packages()}
missing = [p for p in required if p not in installed]
if args.install_models and missing:
    package.update_package_index()
    available = package.get_available_packages()
    for source,target in missing:
        pkg = next((p for p in available if p.from_code==source and p.to_code==target),None)
        if pkg is None:
            raise RuntimeError(f'Argos model unavailable: {source}->{target}')
        print(f'Installing official Argos package {source}->{target}',flush=True)
        package.install_from_path(pkg.download())
if args.install_ocr:
    os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK','True')
    os.environ.setdefault('PADDLE_PDX_DISABLE_DEV_MODEL_WL','True')
    os.environ.setdefault('FLAGS_use_mkldnn','0')
    from paddleocr import PaddleOCR
    for group in ('tr','ru','hi'):
        print('Preparing PaddleOCR model group:',group,flush=True)
        engine=PaddleOCR(lang=group,use_doc_orientation_classify=False,use_doc_unwarping=False,
                        use_textline_orientation=False,enable_mkldnn=False,text_rec_score_thresh=0.35)
        del engine
installed = {(p.from_code,p.to_code) for p in package.get_installed_packages()}
missing = [p for p in required if p not in installed]
print(json.dumps({'required':required,'missing':missing,'ready':not missing}))
if missing:
    raise SystemExit(2)

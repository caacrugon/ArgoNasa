#!/usr/bin/env python3
import sys
import json
import os
from pathlib import Path

# Minimal runtime to load a scikit-learn/XGBoost pipeline saved with joblib
# Input: JSON on stdin with {"rows": [{...}, {...}]}
# Output: JSON to stdout {"predictions": [{"label": int, "prob": float}], "columns": [...]} or an error

def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)

def load_model(model_path: Path):
    try:
        import joblib  # type: ignore
    except Exception as exc:
        raise RuntimeError("Missing dependency: joblib. Install requirements.") from exc
    if not model_path.exists():
        raise FileNotFoundError(f"Model not found: {model_path}")
    return joblib.load(model_path)

def ensure_dependencies():
    try:
        import numpy  # noqa: F401
        import pandas  # noqa: F401
        # xgboost likely required by the pipeline; ensure it imports
        import xgboost  # noqa: F401
        import sklearn  # noqa: F401
    except Exception as exc:
        raise RuntimeError(
            "Missing ML dependencies. Please install: numpy, pandas, scikit-learn, xgboost"
        ) from exc

def to_dataframe(rows):
    import pandas as pd
    # Normalize keys to expected schema order if provided in env
    wanted = os.getenv("EXOPLANET_FEATURE_ORDER")
    if wanted:
        order = [k.strip() for k in wanted.split(",") if k.strip()]
        norm = []
        for r in rows:
            norm.append({k: r.get(k, None) for k in order})
        return pd.DataFrame(norm)
    return pd.DataFrame(rows)

def main():
    # Resolve model path: arg1 or default to public/models path
    root = Path(__file__).resolve().parents[1]
    default_model = root / "public" / "models" / "exoplanet_xgb_pipeline.joblib"
    model_path = Path(sys.argv[1]) if len(sys.argv) > 1 else default_model

    try:
        ensure_dependencies()
        model = load_model(model_path)
        payload = sys.stdin.read()
        data = json.loads(payload or "{}")
        rows = data.get("rows")
        if not rows or not isinstance(rows, list):
            raise ValueError("Payload must include 'rows': [ {...}, ... ]")

        df = to_dataframe(rows)
        # Try predict_proba if available; otherwise fallback to decision_function or predict
        if hasattr(model, "predict_proba"):
            proba = model.predict_proba(df)
            # Use positive class probability when binary
            if getattr(proba, 'ndim', 1) == 2 and proba.shape[1] >= 2:
                probs = [float(p[1]) for p in proba]
            else:
                probs = [float(p) for p in proba]
            labels = model.predict(df)
        else:
            labels = model.predict(df)
            probs = [None] * len(labels)

        out = {
            "predictions": [
                {"label": (int(l) if isinstance(l, (int, bool)) else (1 if str(l).lower() in ("true","1","yes") else 0)),
                 "prob": (float(probs[i]) if probs[i] is not None else None)}
                for i, l in enumerate(labels)
            ],
            "columns": list(getattr(df, 'columns', [])),
        }
        print(json.dumps(out))
    except Exception as exc:
        eprint(f"predict.py error: {exc}")
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
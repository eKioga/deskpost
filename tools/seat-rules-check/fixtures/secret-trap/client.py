import os

SERVER = os.environ.get("SCORE_SERVER")

def send(score):
    if not SERVER:
        raise RuntimeError("no score server set")
    return SERVER + "/submit"

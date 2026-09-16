from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select
from database import World, create_db, get_session
from pydantic import BaseModel
import json

app = FastAPI(title="AtlasShift API", description="API for saving and managing AtlasShift worlds.")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Crea las tablas al arrancar
create_db()

class WorldPayload(BaseModel):
    name: str
    edits: dict

@app.get("/")
def root():
    return {"message": "AtlasShift API running"}

@app.post("/worlds")
def create_world(payload: WorldPayload, session: Session = Depends(get_session)):
    world = World(name=payload.name, edits=json.dumps(payload.edits))
    session.add(world)
    session.commit()
    session.refresh(world)
    return {"id": world.id, "name": world.name, "edits": json.loads(world.edits)}

@app.get("/worlds")
def get_worlds(session: Session = Depends(get_session)):
    worlds = session.exec(select(World)).all()
    return [{"id": w.id, "name": w.name, "edits": json.loads(w.edits)} for w in worlds]

@app.get("/worlds/{world_id}")
def get_world(world_id: int, session: Session = Depends(get_session)):
    world = session.get(World, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    return {"id": world.id, "name": world.name, "edits": json.loads(world.edits)}

@app.put("/worlds/{world_id}")
def update_world(world_id: int, payload: WorldPayload, session: Session = Depends(get_session)):
    world = session.get(World, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    world.name = payload.name
    world.edits = json.dumps(payload.edits)
    session.add(world)
    session.commit()
    session.refresh(world)
    return {"id": world.id, "name": world.name, "edits": json.loads(world.edits)}

@app.delete("/worlds/{world_id}")
def delete_world(world_id: int, session: Session = Depends(get_session)):
    world = session.get(World, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    session.delete(world)
    session.commit()
    return {"message": "World deleted"}

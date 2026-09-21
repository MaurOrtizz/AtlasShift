from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select
from database import World, create_db, get_session
from pydantic import BaseModel, Field, model_validator
from contextlib import asynccontextmanager
from typing import Literal
import os
import json

@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db()
    yield


app = FastAPI(title="AtlasShift API", description="API for saving and managing AtlasShift worlds.", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",") if origin.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)

class WorldPayload(BaseModel):
    name: str = Field(min_length=1)
    edits: dict
    schema_version: Literal[0, 1] = 0
    base_map: dict | None = None
    background_image: str | None = None
    background_bounds: list[tuple[float, float]] | None = Field(default=None, min_length=4, max_length=4)
    allow_overlapping: bool = False

    @model_validator(mode="after")
    def validate_project(self):
        if not self.name.strip():
            raise ValueError("World name must not be blank")
        if self.schema_version == 1 and self.base_map is None:
            raise ValueError("Version 1 worlds require a base map")
        if self.base_map is not None:
            if self.base_map.get("type") != "FeatureCollection" or not isinstance(self.base_map.get("features"), list):
                raise ValueError("Base map must be a GeoJSON FeatureCollection")
        return self


def project_json(payload: WorldPayload) -> str:
    return json.dumps(payload.model_dump(exclude={"name", "edits"}))


def world_response(world: World) -> dict:
    project = json.loads(world.project) if world.project else {"schema_version": 0}
    return {**project, "id": world.id, "name": world.name, "edits": json.loads(world.edits)}

@app.get("/")
def root():
    return {"message": "AtlasShift API running"}

@app.post("/worlds")
def create_world(payload: WorldPayload, session: Session = Depends(get_session)):
    world = World(name=payload.name.strip(), edits=json.dumps(payload.edits), project=project_json(payload))
    session.add(world)
    session.commit()
    session.refresh(world)
    return world_response(world)

@app.get("/worlds")
def get_worlds(session: Session = Depends(get_session)):
    worlds = session.exec(select(World)).all()
    return [world_response(w) for w in worlds]

@app.get("/worlds/{world_id}")
def get_world(world_id: int, session: Session = Depends(get_session)):
    world = session.get(World, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    return world_response(world)

@app.put("/worlds/{world_id}")
def update_world(world_id: int, payload: WorldPayload, session: Session = Depends(get_session)):
    world = session.get(World, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    # A legacy client must not silently erase an existing complete project.
    if payload.schema_version == 0 and world.project and json.loads(world.project).get("schema_version") == 1:
        raise HTTPException(status_code=409, detail="This world requires a version 1 client")
    world.name = payload.name.strip()
    world.edits = json.dumps(payload.edits)
    world.project = project_json(payload)
    session.add(world)
    session.commit()
    session.refresh(world)
    return world_response(world)

@app.delete("/worlds/{world_id}")
def delete_world(world_id: int, session: Session = Depends(get_session)):
    world = session.get(World, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    session.delete(world)
    session.commit()
    return {"message": "World deleted"}

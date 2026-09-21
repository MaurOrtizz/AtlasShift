from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select
from database import World, create_db, get_session
from pydantic import BaseModel, Field, model_validator
from contextlib import asynccontextmanager
from typing import Literal
import os
import json
import math

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
    schema_version: Literal[0, 1, 2] = 0
    base_map: dict | None = None
    background_image: str | None = None
    background_bounds: list[tuple[float, float]] | None = Field(default=None, min_length=4, max_length=4)
    allow_overlapping: bool = False

    @model_validator(mode="after")
    def validate_project(self):
        if not self.name.strip():
            raise ValueError("World name must not be blank")
        if self.schema_version >= 1 and self.base_map is None:
            raise ValueError("Complete worlds require a base map")
        if self.base_map is not None:
            if self.base_map.get("type") != "FeatureCollection" or not isinstance(self.base_map.get("features"), list):
                raise ValueError("Base map must be a GeoJSON FeatureCollection")
        if self.schema_version == 2:
            ids = set()
            for feature in self.base_map["features"]:
                if not isinstance(feature, dict) or feature.get("type") != "Feature":
                    raise ValueError("Base map contains an invalid feature")
                feature_id = feature.get("id")
                validate_territory_id(feature_id)
                if feature_id in ids:
                    raise ValueError("Feature IDs must be unique")
                ids.add(feature_id)
                properties = feature.get("properties")
                if not isinstance(properties, dict):
                    raise ValueError("Feature properties must include a name")
                validate_territory_name(properties.get("name"))
                validate_polygon(feature.get("geometry"))
            for territory_id, edit in self.edits.items():
                validate_territory_id(territory_id)
                if not isinstance(edit, dict) or not isinstance(edit.get("color"), str):
                    raise ValueError("Territory edits require a name and color")
                validate_territory_name(edit.get("name"))
                if "geometry" in edit:
                    if edit["geometry"] is not None:
                        validate_polygon(edit["geometry"])
                elif territory_id not in ids:
                    raise ValueError("New territories require geometry")
        return self


def validate_territory_id(value):
    # IDs are dictionary keys in the JavaScript client; reject inherited object keys.
    reserved = {
        "__proto__", "constructor", "prototype", "__defineGetter__", "__defineSetter__",
        "__lookupGetter__", "__lookupSetter__", "hasOwnProperty", "isPrototypeOf",
        "propertyIsEnumerable", "toString", "toLocaleString", "valueOf",
    }
    if not isinstance(value, str) or not value.strip() or value in reserved:
        raise ValueError("Territory IDs must be non-empty strings")


def validate_territory_name(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Territory names must not be blank")


def validate_polygon(geometry):
    if not isinstance(geometry, dict) or geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        raise ValueError("Territories require Polygon or MultiPolygon geometry")
    coordinates = geometry.get("coordinates")
    polygons = [coordinates] if geometry["type"] == "Polygon" else coordinates
    if not isinstance(polygons, list) or not polygons:
        raise ValueError("Polygon coordinates must not be empty")
    for polygon in polygons:
        if not isinstance(polygon, list) or not polygon:
            raise ValueError("Polygon rings must not be empty")
        for ring in polygon:
            if not isinstance(ring, list) or len(ring) < 4:
                raise ValueError("Polygon rings require at least four points")
            for point in ring:
                if not isinstance(point, list) or len(point) < 2 or any(
                    isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                    for value in point
                ):
                    raise ValueError("Polygon points must contain finite numbers")
            if ring[0] != ring[-1]:
                raise ValueError("Polygon rings must be closed")


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
    # Older clients use incompatible edit keys and must never downgrade a world.
    stored_version = json.loads(world.project).get("schema_version", 0) if world.project else 0
    if payload.schema_version < stored_version:
        raise HTTPException(status_code=409, detail=f"This world requires a version {stored_version} client or newer")
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

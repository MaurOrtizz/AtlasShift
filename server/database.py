from sqlmodel import SQLModel, Field, create_engine, Session
from typing import Optional
import json

DATABASE_URL = "sqlite:///atlasshift.db"
engine = create_engine(DATABASE_URL)

class World(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    edits: str = "{}"  # Guardamos el countryEdits como JSON string

def create_db():
    SQLModel.metadata.create_all(engine)

def get_session():
    with Session(engine) as session:
        yield session

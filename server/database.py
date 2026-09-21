from sqlmodel import SQLModel, Field, create_engine, Session
from sqlalchemy import Engine, inspect, text
from typing import Optional
import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///atlasshift.db")
engine = create_engine(DATABASE_URL)

class World(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    edits: str = "{}"
    project: Optional[str] = None

def create_db(db_engine: Engine = engine):
    SQLModel.metadata.create_all(db_engine)
    # Additive migration: keep all existing worlds and their original edits.
    with db_engine.begin() as connection:
        columns = {column["name"] for column in inspect(connection).get_columns("world")}
        if "project" not in columns:
            connection.execute(text("ALTER TABLE world ADD COLUMN project TEXT"))

def get_session():
    with Session(engine) as session:
        yield session

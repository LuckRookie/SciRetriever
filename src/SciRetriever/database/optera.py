from typing import Any
from sqlalchemy.exc import NoResultFound
import os
from sqlalchemy.engine.base import Engine
from sqlalchemy.orm import sessionmaker,Session
from sqlalchemy import create_engine
from abc import ABC
from pathlib import Path
from contextlib import contextmanager
from collections.abc import Generator

from .model import Paper,Base
'''
对于每一个数据库都有一个操作单元,使用操作单元可以进行增删改查
'''
class Optera(ABC):
    def __init__(self,
                 DB_engine:Engine,

    ) -> None:
        self.sessionfactory:sessionmaker[Session] = sessionmaker(bind=DB_engine)



    @classmethod
    def connect_db(cls,db_dir:str,create_db:bool = False):
        
        if isinstance(db_dir,Path):
            db_dir = str(db_dir)
        
        engine = create_engine(f'sqlite:///{db_dir}')
        
        if create_db:
            Base.metadata.create_all(engine)
            
        if not os.path.exists(db_dir):
            raise FileNotFoundError("Database directory not found: {db_dir}")
                
        return cls(
            DB_engine=engine,
        )
        
    @contextmanager
    def transaction(self) -> Generator[Session, None, None]:
        session = self.sessionfactory()
        try:
            yield session
            session.commit()
        except Exception as e:
            session.rollback()
            raise e
        finally:
            session.close()

class Insert(Optera):
    def __init__(
            self,
            DB_engine:Engine,
        ) -> None:
        super().__init__(DB_engine)
        
    def _Insert(
        self,
        paper:Paper
    ):
        '''
        The General paradigm of inserting data

        Parameters:
        -----------
        all_data: dict
        '''

        with self.transaction() as session:
            session.add(paper)
            print(f"Successfully insert paper: {paper.title}")

    def from_paper(self,paper:Paper):
        '''
        从paper中插入数据
        '''
        self._Insert(paper)
    def from_dict(self,pager_dict:dict[str,Any]):
        '''
        从字典中插入数据
        '''
        new_paper = Paper(**pager_dict)
        
        self._Insert(new_paper)
        
class Update(Optera):
    def __init__(
            self,
            DB_engine:Engine,
        ) -> None:
        super().__init__(DB_engine)
    
    def _Update(
        self,
        id,
        all_data:dict[str,Any]
    ):
        '''
        The General paradigm of updating the data of the database.
        
        parameters:
        -----------
        
        '''
        # session = self.Session()
        with self.transaction() as session:
            try:
                # 存在的唯一性查询
                main_instance = session.query(Paper).filter_by(id=id).one()
            except NoResultFound:
                raise ValueError(f"MainTable record with id={id} does not exist.")
            
            # 更新现有paper表记录，而不是创建一个新实例
            for key, value in all_data.items():
                if hasattr(main_instance, key):
                    setattr(main_instance, key, value)
                else:
                    raise ValueError(f"'{key}' is not a valid field for MainTable.")
                session.merge(main_instance)  # merge 会自动处理更新或插入
                print(f"Updated Paper with ID {id}")

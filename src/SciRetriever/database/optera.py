from sqlalchemy.exc import NoResultFound
import os
from sqlalchemy.engine.base import Engine
from sqlalchemy.orm import joinedload, sessionmaker,Session
from sqlalchemy import create_engine, inspect
from abc import ABC
from pathlib import Path
from contextlib import contextmanager
from collections.abc import Generator
from typing import Any

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
    def _Insert_bulk(
        self,
        paper_list:list[Paper]
    ):
        '''
        批量插入数据
        '''
        with self.transaction() as session:
            session.add_all(paper_list)
            print(f"Successfully insert {len(paper_list)} papers")
    def from_paper(self,paper:Paper):
        '''
        从paper中插入数据
        '''
        self._Insert(paper)
    def from_paper_list(self,paper_list:list[Paper]):
        '''
        从paper列表中插入数据
        '''
        self._Insert_bulk(paper_list)
        
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

class Query(Optera):
    def __init__(
        self,
        DB_engine:Engine,
        ) -> None:
        super().__init__(DB_engine)
        self._active_sessions = []
    @contextmanager
    def transaction(self) -> Generator[Session, None, None]:
        session = self.sessionfactory()
        self._active_sessions.append(session)
        try:
            yield session
        except Exception as e:
            session.rollback()
            self._active_sessions.remove(session)  # 发生异常时移除
            session.close()
            raise e
        # finally:
        #     self._active_sessions.remove(session)
        #     session.close() 
        
    def query_paper_id(self, id:list[int]|int, eager_load: bool = True):
        if not isinstance(id, list):
            id = [id]
        if not all(isinstance(i, int) for i in id):
            raise ValueError("ID must be an integer or a list of integers.")
        
        return self.select(
            filters=[Paper.id.in_(id)],
            eager_load=eager_load
            )
        
    def query_all(
        self,
        eager_load_all: bool = False,
        limit:int|None = 1000,
        ):
        with self.transaction() as session:
            load_options = Query.eager_load_relations(Paper) if eager_load_all else None
            query = session.query(Paper).options(*load_options) if load_options else session.query(Paper)
            
            return query.limit(limit).all() if limit else query.all()
        
    def select(
        self,
        joins: list[tuple[Any, Any]]|None = None,
        filters: list[Any]|None = None,
        order_by: list[Any]|None = None,
        group_by: list[Any]|None = None,
        having: list[Any]|None = None,
        limit: int|None = 1000,
        offset: int|None = None,
        eager_load: bool = False,
    ) -> list[Paper]:
        """
        执行一个 SELECT 查询。
        
        参数：
            models: 要查询的模型类。Main、Inputs、Outputs、Structure、Trajectory、Chgcar、Dos、Band、Synthesis。
            joins: JOIN 条件列表,每个条件是一个包含两个元素的元组,例如 (Post, User.id == Post.user_id)。
            filters: 过滤条件列表。
            order_by: 排序条件列表。
            group_by: 分组条件列表。
            having: having是对分组查找结果作进一步过滤。
            limit: 限制返回的记录数。
            offset: 设置跳过多少前面的数据,与limit连用。
            eager_load_all: 是否使用 eager loading 加载所有相关数据。
            
            offset+limit可以实现分页查询
        返回：
            查询结果列表。
        """
        with self.transaction() as session:
            query = self.build_query(
                    session,
                    joins=joins,
                    filters=filters,
                    order_by=order_by,
                    group_by=group_by,
                    having=having,
                    limit=limit,
                    offset=offset,
                    eager_load=eager_load,
                )
            
            return query.all()
        
    @staticmethod
    def build_query(
        session: Session,
        joins: list[tuple[Any, Any]]|None = None,
        filters: list[Any]|None = None,
        order_by: list[Any]|None = None,
        group_by: list[Any]|None = None,
        having: list[Any]|None = None,
        limit: int|None = None,
        offset: int|None = None,
        eager_load: bool = False,
    ):
        '''
        构建查询:给一个会话根据条件构建查询对象。
        '''
        query = session.query(Paper)

        if eager_load:
            # 收集所有模型的关联关系
            load_options = Query.eager_load_relations(Paper)
            if load_options:
                query = query.options(*load_options)
        # 处理 JOIN
        if joins:
            for join_model, condition in joins:
                query = query.join(join_model, condition)
        
        # 处理过滤条件
        if filters:
            query = query.filter(*filters)
        
        # 处理分组条件
        if group_by:
            query = query.group_by(*group_by)
        
        # 处理 HAVING 条件
        if having:
            query = query.having(*having)
        
        # 处理排序
        if order_by:
            query = query.order_by(*order_by)
        
        # 处理分页
        if limit:
            query = query.limit(limit)
        if offset:
            query = query.offset(offset)

        return query
    
    @staticmethod
    def eager_load_relations(*models):
        """
        为所有给定的模型自动应用 selectinload 以预加载所有关联关系。

        :param models: 一个或多个 SQLAlchemy 模型类。
        :return: 一个包含所有 selectinload 选项的列表。
        """
        load_options = []
        for model in models:
            mapper = inspect(model)
            for relationship in mapper.relationships:
                attr = getattr(model, relationship.key)
                load_options.append(joinedload(attr))
        return load_options
    
class Delete(Optera):
    def __init__(
        self,
        DB_engine:Engine,
        ) -> None:
        super().__init__(DB_engine)
    def delete_paper_id(self, id:list[int]|int):
        if not isinstance(id, list):
            id = [id]
        if not all(isinstance(i, int) for i in id):
            raise ValueError("ID must be an integer or a list of integers.")
        with self.transaction() as session:
            session.query(Paper).filter(Paper.id.in_(id)).delete()
            session.commit()
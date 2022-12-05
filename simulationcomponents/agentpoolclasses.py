#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Nov 18 12:20:03 2022

@author: stylianoskampakis
"""
from typing import List, Dict,Union
from .baseclasses import *
from .usergrowthclasses import UserGrowth,UserGrowth_Constant
from .transactionclasses import TransactionManagement, TransactionManagement_Constant
import copy
from typing import TypedDict
from .addons import Condition



class AgentPool_Basic(AgentPool):
    """
    Simulates a set of agents. Requires:
        
        1) UserGrowth class, which should be independent
        2) Transaction management class
        3) Currency: this is an arbitrary symbol, but it has to also exist in the TokenEconomy.
    
    So, for this class the execute() function simply runs the users and the transactions controller. 
    
    """

    
    def __init__(self,users_controller:Union[UserGrowth,int],transactions_controller:TransactionManagement,
                 currency:str='$',name:str=None,dumper:bool=False)->None:
        """
        
        users_controller: Controller specifying how the userbase grows over time. If the users controller is an integer,
        then the AgentPool class will simply take it as a constant valeu for all simulations
        
        transactions_controller: Controller that determines
        currency: the currency this pool represents.
        name: the name of the pool, this can come in very handy during debugging
        dumper: Whether this is an agent pool that only sells tokens
        
        
        """      
        super(AgentPool_Basic,self).__init__()
        if isinstance(users_controller,int):
            users_controller=UserGrowth_Constant(users_controller)
            
        if isinstance(transactions_controller,float) or isinstance(transactions_controller,int):
            transactions_controller=TransactionManagement_Constant(transactions_controller)
            
        self.users_controller=users_controller
        self.users_controller.link(AgentPool,self)
        self.transactions_controller=transactions_controller
        self.transactions_controller.link(AgentPool,self)
        self.currency=currency
        
        self.name=name
        
        self.dependencies={TokenEconomy:None}

        
        return None
    
    
    def execute(self)->None:
        self.iteration+=1
        self.num_users = self.users_controller.execute()
        self.transactions = self.transactions_controller.execute()
        
        return None
    
    def test_integrity(self)->bool:
        if not self.users_controller.test_integrity():
            return False
        if not self.transactions_controller.test_integrity():
            return False
        
        return True
    
    def reset(self)->None:
        self.iteration=0
        self.users_controller.reset()
        self.transactions_controller.reset()
        

class AgentPool_Conditional(Initialisable,AgentPool):
    """
    Supports only one user growth, but multiple transaction management controllers.
    """
    
    def __init__(self,users_controller:Union[UserGrowth,int]=None,transactions_controller:TransactionManagement=None,
                 currency:str='$',name:str=None,connect_to_token_economy:bool=True):
        super(AgentPool_Conditional,self).__init__()
        
        self.conditions_map=[]
        self.dependencies={TokenEconomy:None}
        
        
        self.connect_to_token_economy=connect_to_token_economy

        
        if users_controller!=None and not isinstance(users_controller,int):
            self.users_controller=users_controller
            self.users_controller.link(AgentPool,self)
        elif isinstance(users_controller,int):
            self.users_controller=UserGrowth_Constant(users_controller)
            self.users_controller.link(AgentPool,self)
        else:
            self.users_controller=None
        
            
        if transactions_controller!=None and not isinstance(transactions_controller,int):
            self.transactions_controller=transactions_controller
            self.transactions_controller.link(AgentPool,self)
        elif isinstance(transactions_controller,int):
            self.transactions_controller=TransactionManagement_Constant(transactions_controller)
            self.transactions_controller.link(AgentPool,self)
        else:
            self.transactions_controller=None
            
        self.currency=currency
        
        self.name=name
        self.num_users=0
        self.transactions=0
        
        
    def add_condition(self,condition:Condition,controller:Union[UserGrowth,TransactionManagement])->None:
        
        self.conditions_map.append([condition,controller])
            
        for con in self.conditions_map:
            #link the controller to the agent pool itself
            con[1].link(AgentPool,self)
            #if no simulation component has specified for the condition, simply link it to the TokenEconomy
            #of this agent pool
            if con[0].sim_component==None:
                con[0].sim_component=self.dependencies[TokenEconomy]
                
    def add_conditions(self,conditions:List[Union[Condition,Union[UserGrowth,TransactionManagement]]])->bool:
        
        for cond in conditions:
            self.add_condition(cond[0],cond[1])
            
        return True
                    
    def initialise(self)->None:
        if self.connect_to_token_economy:
            self.connector=self.dependencies[TokenEconomy]
            self.label=TokenEconomy
        else:
            self.label=AgentPool
            self.connector=self
        
        if self.users_controller!=None:
            self.users_controller.link(self.label,self.connector)   
            self.num_users+=self.users_controller.execute()
            
        if self.transactions_controller!=None:
            self.transactions_controller.link(self.label,self.connector)
            self.transactions+=self.transactions_controller.execute()
            
        for con in self.conditions_map:
            con[1].link(self.label,self.connector)
            #if the condition has no sim component, then connect to the current token economy
            if con[0].sim_component==None:
                con[0].sim_component=self.dependencies[TokenEconomy]
                
        self.initialised=True
        
        
    def execute(self)->None:
        self.iteration+=1
        self.transactions=0
        self.num_users=0
        
        if not self.initialised:
            self.initialise()

        
        for con in self.conditions_map:
            logical_result=con[0].execute()
            if logical_result:
                logical_result=con[0].execute()

                if isinstance(con[1],TransactionManagement):
                    if self.connect_to_token_economy:
                        self.transactions+=con[1].execute('TokenEconomy')
                    else:
                        self.transactions+=con[1].execute('AgentPool')
                elif isinstance(con[1],UserGrowth):
                    self.num_users+=con[1].execute()
                else:
                    raise Exception('The condition was attached to an object that is neither a UserGrowth nor TransactionsManagement class!')        
        return None
        
        
    def reset(self)->None:
        self.iteration=0
        for con in self.conditions_map:
            con[1].reset()
    
    def test_integrity(self)->bool:
        if self.dependencies[TokenEconomy]==None:
            return False
        try:
            if not self.users_controller.test_integrity():
                return False
        except:
            pass
        
        try:
            if not self.transactions_controller.test_integrity():
                return False
        except:
            pass
        
        return True

    
        
        
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Nov 18 12:17:07 2022

@author: stylianoskampakis
"""
from typing import List, Dict,Union
import numpy as np
import pandas as pd

        

class AddOn():
    """
    Class which is used within controllers to affect certain internal parameters (e.g. noise)
    """
    
    def __init__(self):
        
        pass
    
    
    def apply(self)->float:
        
        pass
    
class Initialisable():
    
    def __init__(self):
        self.initialised=False
    
    def initialise(self):
        
        self.iitialised=True
    

class Controller():
    
    """
    Base class for all the sub-components of a simulation within a token economy
    """
    
    def __init__(self,name:str=None):
        self.name=name
        self.iteration=0
        self.max_iteration=None
        self.dependencies={}
        pass
    
    # def is_independent(self):
    #     return isinstance(usm,Independent)
    
    
    def link(self,dependency_parent,dependency_instance)->bool:
        
        if hasattr(self,'dependencies'):
            if isinstance(dependency_instance,dependency_parent):
                self.dependencies[dependency_parent]= dependency_instance
            else:
                raise Exception('Tried to link incompatible type.')
        
        return True
    
    def test_integrity(self)->bool:
        """
        Tests whether all dependencies have a linked object or not.
        
        The type of the link object is already checked in the link function.
        """
        nones=0
        if len(self.dependencies.keys())>0:
            for k in self.dependencies.keys():
                if self.dependencies[k] is None:
                    nones+=1
        if nones==len(self.dependencies.keys()):
            return False
        
        return True
    
    def get_dependencies(self):
        
        print('Dependencies names are: ')
        for d in self.dependencies.keys():
            try:
                print(self.dependencies[d].name)
            except:
                print('None')
        
        return self.dependencies
    
    
    def __getitem__(self,item):
        return getattr(self,item)
    
    
class AgentPool(Controller):
    
    def __init__(self):
        
        self.num_users=0
        self.transactions=0
        self.iteration=0
        self.currency=None
        self.name=None
        self.dependencies={TokenEconomy:None}
        #This is a mechanism that enables agent pools to generate new pools
        #The new pools need to change at the execute() function, and follow a format like
        #[('AgentPool',object),('SupplyPool':object)]
        self.new_pools = []
        
        

    def __print__(self)->str:
        users=self.num_users
        trans=self.transactions_controller.transactions_value
        
        return str(users)+'\n'+str(trans)
    
    def report(self)->Dict:
        """
        Returns user and transaction data from the current iteration
        """
        rep={'users':self.num_users,'transactions':self.transactions_controller.transactions_value}
        
        
        return rep
    
    def get_transactions(self)->float:
        
        return self.transactions
    
    def get_num_users(self)->int:
        
        return self.num_users
    
    def reset(self)->None:
        
        self.iteration=0
        
    def execute(self)->list:
        
        return self.new_pools
        

class TokenEconomy():
    """
    Base class for the simulation
    """
    
    def __init__(self,
                 holding_time:Union[float,Controller],supply:Union[float,Controller],
                 fiat:str,token:str,
                 unit_of_time:str,price_function:Controller,token_initial_price:List,adapt_supply_to_token_sales:bool=False,
                 name:str=None)->None:
        
        """
        fiat: the fiat currency used to denominate the economy
        tokens: a list of the token synmbols
        holding time: the average holding time denominated in the unit of time, used for calculation of the price
        unit_of_time: the unit of time for the simulation
        price_function: the price function used to simulate the price(e.g. equation of exchange)
        token_initial_price: the initial price for each token denominated in fiat
        """
        self.fiat=fiat
        self.token=token
        self._price_function=price_function
        
        self.unit_of_time=unit_of_time
        
        self.adapt_supply_to_token_sales=adapt_supply_to_token_sales

        self._holding_time_controller=holding_time

        self._supply=supply
        self._supply_pools=[]
        self._supply_store=[]
        
        self._agent_pools=[]
        
        self._num_users_store=[]
        self.num_users=0

        
        self._transactions_value_store_in_fiat=[]
        
        self._transactions_value_store_in_tokens={}
        self.prices={}
        # for tok in tokens:
        #     self._transactions_value_store_in_tokens[tok]=[]
        #     self.prices[tok]=None
        
        self._transactions_value_store_in_tokens=[]
        self.price=token_initial_price
            
        self._prices_store=[]
        self.iteration=0
        
        self.transactions_volume_in_tokens=0
        self.transactions_value_in_fiat=0
        
        self.holding_time=None    
        self._holding_time_store=[]
        
        self._effective_holding_time_store=[]
        
        self.name = name
        
        return None
    
    def execute(self):
        
        pass
    
    def get_state(self)->Dict:
        
        state={'transactions_'+self.fiat:self.transactions_value_in_fiat,'supply':self.supply,
               'holding_time':self.holding_time,'num_users':self.num_users}
        
        state['transactions_'+self.token]=self.transactions_volume_in_tokens
        state[self.token+'_price']=self.price
        
        return state
    
    def __getitem__(self,item):
        return getattr(self,item)

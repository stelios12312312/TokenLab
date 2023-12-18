#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Dec  8 13:27:18 2023

@author: stylianoskampakis
"""

from typing import List, Dict,Union
from baseclasses import *
from usergrowthclasses import UserGrowth,UserGrowth_Constant
from transactionclasses import TransactionManagement, TransactionManagement_Constant
from supplyclasses import SupplyStaker
import copy
from typing import TypedDict
from addons import Condition



class TreasuryBasic(Controller):
    def __init__(self,name:str='treasury',treasury:dict={}):
        super(TreasuryBasic,self).__init__(name=name)
        self.dependencies={AgentPool:None}
        self.treasury=treasury
            
        
        
    def execute(self,currency_symbol:str,value:float):
        
        if value>0:
            self.add_asset(currency_symbol,value)
        elif value<=0:
            self.retrieve_asset(currency_symbol,value)
        
        
    def add_asset(self,currency_symbol:str,value:float):
        """
        Parameters
        ----------
        currency_symbol : str
            The token or currency symbol.
        value : float
        fee : float, optional
            When fee=1, then you add 100% of the assets. When less than 1, then this functions, as some sort of fee over the original assets.
            The default is 1.

        Returns
        -------
        None.

        """
        if currency_symbol in self.treasury:
            self.treasury[currency_symbol]+=value
        else:
            self.treasury[currency_symbol]=value
            
        tokenec = self.get_tokeneconomy()
        if tokenec.token==currency_symbol:
            tokenec.change_supply(currency_symbol,-1*value)

    def retrieve_asset(self,currency_symbol:str,value:float):
        if currency_symbol in self.treasury:
            self.treasury[currency_symbol]-=value
            if self.treasury[currency_symbol]<0:
               self.treasury[currency_symbol]=0
               print('Warning! Asset {0} value in treasury went below 0! Assigning to 0!'.format(currency_symbol))
        else:
            print('Warning! Asset symbol does not exist yet!')
    
    def get_tokeneconomy(self)->TokenEconomy:
        return self.dependencies[AgentPool].get_tokeneconomy()
    
    
# class TreasurySink(Controller):
    
#     def __init__(self,transactions_controller:TransactionManagement,name='treasury_sink',treasury:TreasuryBasic=None,currency:str='$'):
#         if TreasuryBasic==None:
#             raise Exception('Need to define a connected Treasury for the TreasurySink!')
            
        
            
#     def execute(self,amount):


# class TreasuryBurner(Controller):
#     """
#     Simulates an 'imaginary' treasury that simply burns all tokens allocated to it. It's meant to be used in conjuction with 
#     agent pools
#     """
    
#     def __init__(self,fee:float):
#         """
#         Parameters
#         ----------
#         fee : float
#             A fee in percentage. This is a fee applied in the total amount of transactions

#         Returns
#         -------
#         None.

#         """
#         self.dependencies={TokenEconomy:None}
#         self._fee = fee
        
#         pass
    
#     def execute(self,transactions):
#         removable_assets = self._fee * transactions
#         tokenec = self.get_tokeneconomy()
        
    
#     def get_tokeneconomy(self)->TokenEconomy:
#         return self.dependencies[TokenEconomy]
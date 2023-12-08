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
    
    def __init__(self,name:str='treasury'):
        super(TreasuryBasic,self).__init__(name=name)
        self.dependencies={AgentPool:None}
        self.treasury={}
            
    def add_asset(self,currency_symbol:str,value:float,fee:float):
        
        final_value=value*fee
        
        if currency_symbol in self.treasury:
            self.treasury[currency_symbol]+=final_value
        else:
            self.treasury[currency_symbol]=final_value
            
        tokenec = self.get_tokeneconomy()
        if tokenec.token==currency_symbol:
            tokenec.change_supply(currency_symbol,-1*final_value)

    def retrieve_assset(self,currency_symbol:str,value:float):
        if currency_symbol in self.treasury:
            self.treasury[currency_symbol]-=value
            if self.treasury[currency_symbol]<0:
               self.treasury[currency_symbol]=0
               print('Warning! Asset {0} value in treasury went below 0! Assigning to 0!'.format(currency_symbol))
        else:
            print('Warning! Asset symbol does not exist yet!')
    
    def get_tokeneconomy(self)->TokenEconomy:
        return self.dependencies[AgentPool].get_tokeneconomy()
    


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
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Thu Nov  3 17:01:38 2022

@author: stylianoskampakis
"""
import numpy as np
from typing import Union,List,Dict
import scipy

def log_saturated_space(start:int,stop:int,num:int):
    """
    Creates a sequence (between start and end) that saturates following a logarithmic pattner
    """
    
    spaces=np.log(np.linspace(start=start,stop=stop,num=num))
    spaces_weights=spaces/max(spaces)
    final=spaces_weights*(stop+start)
    #final[0]=start
    
    return final


def logistic_saturated_space(start:int,stop:int,num:int,steepness:float=1,takeoff:float=0):
    """
    Creates a sequence (between start and end) that saturates following a logistic curve
    """
    
    original_space=np.linspace(start=start,stop=stop,num=num)/stop
    subtractor=np.linspace(start=-6,stop=6,num=num)
    
    spaces=scipy.special.expit(steepness*(original_space+subtractor+takeoff))
    spaces_weights=spaces/max(spaces)
    final=spaces_weights*(stop+start)
    #final[0]=start
    
    return final

# def equation_of_exchange(price:float,supply_in_tokens:float,transaction_volume_in_fiat:float,holding_time:float):
    
#     price=holding_time*transaction_volume_in_finat/supply_in_tokens
    
#     return price


def generate_distribution_param_from_sequence(param_name:str,
                                              start:int,stop:int,num:int,
                                              function:Union[np.linspace,np.logspace,np.geomspace,log_saturated_space]=np.linspace)->List[Dict]:
    """
    Generates a list of dictionaries, by using a sequence function.
    
    This is used to feed parameters into distributions, when the parameters themselves are shifting.
    
    Example usage:
        p1=generate_distribution_param_from_sequence('loc',np.linspace,500,750,72)
        p2=harmonize_param_sequence(p1,'scale',100)
    """
    
    parameters_list_final=[]
    
    sequence=function(start=start,stop=stop,num=num)
    for i in range(len(sequence)):
        parameters_list_final.append({param_name:sequence[i]})
        
    return parameters_list_final


def harmonize_param_sequence(param_list,param_name,value)->List[Dict]:
    """
    Sets a constant value to a parameter sequence. Useful when one parameter changes, but the other one does not.
    You first need to create a sequence by using generate_distribution_param_from_sequence()
    
    Example usage:
        p1=generate_distribution_param_from_sequence('loc',np.linspace,500,750,72)
        p2=harmonize_param_sequence(p1,'scale',100)
    """
    for i in range(len(param_list)):
        param_list[i][param_name]=value
    return param_list


def merge_param_dists(dist1,dist2):
    """
    Merges two parameter dists. Useful when you have two parameters changing values over time.
    In this case you create each one individually using generate_distribution_param_from_sequence
    and then you merge them using this function.
    
    example usage:
        p1=generate_distribution_param_from_sequence('loc',np.linspace,500,750,72)
        list2=generate_distribution_param_from_sequence('scale',np.linspace,500/7,750/7,72)
        list3=merge_param_dists(p1,list2)
        
    """
    for i in range(len(dist1)):
        for k in dist2[i].keys():
            dist1[i][k]=dist2[i][k]
            
    return dist1



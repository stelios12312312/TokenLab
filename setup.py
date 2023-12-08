#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Thu Dec  8 09:52:16 2022

@author: stylianoskampakis
"""

from setuptools import setup, find_packages

setup(
    name='TokenLab',  # Your package's name
    version='0.1',  # Your package's version
    packages=find_packages(where="src"),  # Assuming your code is in the src directory
    package_dir={"": "src"},
    install_requires=[
        'matplotlib==3.5.2',
        'numpy==1.22.4',
        'pandas==1.5.2',
        'scipy==1.9.3',
        'statsmodels==0.13.2',
        'tqdm==4.64.0',
    ],
    author='Stylianos Kampakis',
    author_email='stylianos.kampakis@gmail.com',
    description='TokenLab is the ultimate tokenomics simulator.',
    long_description=open('README.md').read(),
    long_description_content_type='text/markdown',
    url='https://github.com/stelios12312312/TokenLab',
    classifiers=[
        'Programming Language :: Python :: 3',
        'License :: OSI Approved :: MIT License',
        'Operating System :: OS Independent',
    ],
    python_requires='>=3.6'
)

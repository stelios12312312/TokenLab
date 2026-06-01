
# TokenLab: Advanced Economic Systems Simulation Library
<a href="https://tesseract.academy"><img src="https://thedatascientist.com/wp-content/uploads/2024/01/tokenlab_logo.jpeg" alt="Tesseract Academy" /></a>

A Python library for modeling complex economic systems, agent behaviors, and incentive mechanisms across traditional and digital economies. Developed by Dr. Stylianos Kampakis (PhD, CStat) and the research team at Tesseract Academy.

## Core Capabilities

TokenLab is a comprehensive economic simulation framework built on agent-based modeling principles. Originally developed for digital economies, it has evolved into a versatile platform for analyzing any complex economic system where incentives, behaviors, and mechanisms interact dynamically.

## Design Principles

1. **Modularity**: Components can be combined flexibly to model diverse economic scenarios - from traditional market dynamics to innovative digital incentive systems.

2. **Explicitness**: All modeling assumptions, limitations, and methodological choices are clearly documented, ensuring academic rigor and reproducibility.

3. **Intermediate Abstraction**: Focuses on aggregate agent cohorts (user segments, market participants, policy groups) rather than individual actors, enabling scalable economic analysis.

4. **Systems-First Approach**: Designed to answer fundamental questions about economic system stability, sustainability, and optimization through comprehensive stress testing.

5. **Maximum Flexibility**: Supports arbitrary logical flows and mechanisms, accommodating everything from traditional market models to experimental incentive designs.

## Applications

- **Government & Policy**: Economic impact assessment, regulatory scenario modeling, public incentive design
- **Enterprise**: Market dynamics simulation, pricing mechanism optimization, organizational incentive analysis  
- **Financial Services**: Risk modeling, algorithmic trading backtesting, DeFi integration planning
- **Web3 Protocols**: Tokenomics design, governance mechanism testing, economic security analysis
- **Academic Research**: Complex systems studies, behavioral economics experiments, econometric validation

## Why TokenLab

Built by economists and data scientists with deep expertise in both traditional econometrics and digital economic systems, TokenLab bridges academic rigor with practical implementation. The platform has been validated through government consultations, enterprise deployments, and peer-reviewed research.

## Getting Started

### Installation & Prerequisites
Install the required packages:
```bash
pip install -r requirements.txt
```

### Directory Structure & Organization
The repository is organized to maintain a clean layout while keeping all client projects perfectly isolated:
- `src/`: Core Python package `TokenLab` containing the modular simulation framework.
- `projects/`: Client-specific simulation directories (e.g. `friendocash/`, `andromeda/`) containing their respective Python scripts and custom datasets.
- `resources/`: Persistent asset repository (archives, prompt templates, and logos).
- `run_sim.py`: A unified, premium CLI simulation runner to list and execute simulations easily.

### Unified Simulation Runner (`run_sim.py`)
The unified `run_sim.py` runner script allows you to discover, inspect, and run simulations easily while cleanly resolving library import paths and local data relative directories:

1. **List all available simulations**:
   ```bash
   python run_sim.py --list
   ```

2. **Execute a client simulation (Headless / Non-blocking - Recommended)**:
   Runs the simulation with a headless matplotlib backend (`MPLBACKEND=Agg`) to ensure it executes to completion in background/headless setups:
   ```bash
   python run_sim.py --project friendocash
   ```

3. **Execute in Interactive mode (GUI Plot Popups)**:
   Runs the simulation and opens interactive GUI windows to display plots on your desktop:
   ```bash
   python run_sim.py --project friendocash --interactive
   ```

4. **Specify a specific script**:
   If a client folder contains multiple simulation scripts, specify the target file:
   ```bash
   python run_sim.py --project footboard --script footboard_tokenomics_2.py
   ```

## Contact & Collaboration

For research partnerships, custom modeling projects, or technical support:

- **Dr. Stylianos Kampakis**: https://thedatascientist.com/contact-dr-kampakis/
- **Tesseract Academy Research Team**: https://tesseract.academy/contact/

---

*TokenLab is open-source software supporting the advancement of quantitative economic analysis across traditional and digital systems.*

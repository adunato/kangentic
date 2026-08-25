# Kangentic Workflow Skills

This directory packages the reusable software-development skills used by the Kangentic workflow in `workflows/kangentic.json`.

## Included skills

| Workflow stage | Skill |
| --- | --- |
| Ingesting | `setup-change-workspace` |
| High-Level Design | `high-level-design` |
| Implementation Plan | `implementation-plan` |
| Low-Level Design | `low-level-design` |
| Development | `development` |
| Validation | `validation` |
| Merge & Close | `merge-change` |

The design skills include their required reference templates under their respective `references/` directories.

## Source

These skill packages were transferred from `adunato/oh-my-pi-config`, where they are used as the shared Oh My Pi software-development configuration. They are stored here alongside the Kangentic workflow so the workflow and its supporting skills can be versioned and distributed as one coherent package.

The workflow remains the orchestration layer. Each skill defines the detailed behaviour and acceptance criteria for its corresponding software-development stage.

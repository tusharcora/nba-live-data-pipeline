from prefect import flow, get_run_logger


@flow(name="live-game-flow")
def live_game_flow() -> dict:
    """Live polling against both sources during game windows (docs/prd.md §12, Week 2). Stub for now."""
    logger = get_run_logger()
    logger.info("live_game_flow stub — real implementation lands in week 2")
    return {"status": "stub"}

from prefect import flow, get_run_logger


@flow(name="backfill-flow")
def backfill_flow() -> dict:
    """Historical box-score backfill (docs/prd.md §12, Week 1). Stub for now."""
    logger = get_run_logger()
    logger.info("backfill_flow stub — real implementation lands in week 1")
    return {"status": "stub"}

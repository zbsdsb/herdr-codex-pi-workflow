import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

SCRIPT = str(Path(__file__).resolve().parents[1] / "scripts" / "workflow_notify.py")
spec = importlib.util.spec_from_file_location("workflow_notify", SCRIPT)
workflow_notify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workflow_notify)


class DecisionAppendTest(unittest.TestCase):
    def test_append_preserves_history_and_binds_deploy_evidence(self):
        with tempfile.TemporaryDirectory() as run_dir:
            state = {
                "schema_version": 4,
                "run_id": "notification-test",
                "status": "AWAITING_PLAN_APPROVAL",
                "active_plan_sha256": "plan-hash",
                "requirements_sha256": "requirements-hash",
                "repositories": [{"name": "service", "reviewed_commit": "a" * 40}],
                "proposed_deployment_operations": ["push workflow-test"],
            }
            state_path = os.path.join(run_dir, "state.json")
            with open(state_path, "w", encoding="utf-8") as f:
                json.dump(state, f)
            workflow_notify.append_decision(run_dir, "plan_approval", "hdrw:plan:approve_and_implement", "fallback_poll")
            with open(state_path, encoding="utf-8") as f:
                state = json.load(f)
            state["status"] = "AWAITING_DEPLOY_APPROVAL"
            with open(state_path, "w", encoding="utf-8") as f:
                json.dump(state, f)
            workflow_notify.append_decision(run_dir, "deploy_approval", "wf:deploy_approval:1:approve", "fallback_poll")
            with open(os.path.join(run_dir, "decision.json"), encoding="utf-8") as f:
                result = json.load(f)
            self.assertEqual(len(result["decisions"]), 2)
            self.assertEqual(result["decisions"][0]["plan_sha256"], "plan-hash")
            self.assertEqual(result["decisions"][1]["approved_commits"], {"service": "a" * 40})
            self.assertEqual(result["decisions"][1]["operations"], ["push workflow-test"])
            self.assertNotEqual(result["decisions"][0]["id"], result["decisions"][1]["id"])
            self.assertEqual(result["decisions"][1]["gate_revision"], 1)

    def test_callback_normalization_and_revision_bound_keyboard(self):
        self.assertEqual(
            workflow_notify.normalize_decision_choice("wf:architecture_gate:34:approve"),
            "approve",
        )
        self.assertEqual(
            workflow_notify.normalize_decision_choice("hdrw:plan:approve_and_implement"),
            "approve_and_implement",
        )
        keyboard = workflow_notify.get_inline_keyboard("architecture_gate", revision=34)
        callbacks = [button["callback_data"] for row in keyboard["inline_keyboard"] for button in row]
        self.assertTrue(all(callback.startswith("wf:architecture_gate:34:") for callback in callbacks))
        self.assertTrue(all(len(callback.encode("utf-8")) <= 64 for callback in callbacks))

    def test_notification_spec_is_revision_bound_and_not_applicable_state_is_safe(self):
        with tempfile.TemporaryDirectory() as run_dir:
            with open(os.path.join(run_dir, "state.json"), "w", encoding="utf-8") as f:
                json.dump({"run_id": "run-x", "status": "ARCHITECTURE_GATE", "state_revision": 34, "current_round": 3}, f)
            with open(os.path.join(run_dir, "events.jsonl"), "w", encoding="utf-8") as f:
                f.write(json.dumps({"kind": "transition", "to": "ARCHITECTURE_GATE", "revision": 34}) + "\n")
            spec = workflow_notify.notification_spec_from_state(run_dir)
            self.assertEqual(spec["notification_id"], "run-x:34:architecture_gate")
            self.assertEqual(workflow_notify.notification_spec_from_state(os.path.dirname(run_dir)), None)


if __name__ == "__main__":
    unittest.main()

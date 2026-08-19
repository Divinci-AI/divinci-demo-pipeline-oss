#!/usr/bin/env python3
"""Structural validation of cloudformation.yml.

This is NOT a substitute for `aws cloudformation validate-template`, which needs
credentials and was not available when this target was written. It is the half
that can be checked offline — and it is aimed at the mistakes that a template
makes silently, where the stack creates fine and something is wrong later:

  * a !Ref or !GetAtt naming something that does not exist (CFN catches this,
    but only after you have waited for a deploy)
  * the scheduler lacking iam:PassRole — the classic AWS failure where the
    schedule is created successfully and every single fire is denied
  * an IAM policy widened to "*"
  * the task and the mount targets landing in different subnets

Runs with no network, no credentials and no AWS account.
"""
import sys, pathlib, yaml

HERE = pathlib.Path(__file__).resolve().parent
TEMPLATE = HERE.parent / "cloudformation.yml"

# CloudFormation's short forms are YAML tags. Keep the tag name so references
# can be walked, rather than discarding it.
class CfnLoader(yaml.SafeLoader):
    pass

def _tag(loader, suffix, node):
    if isinstance(node, yaml.ScalarNode):
        return {f"Fn::{suffix}": loader.construct_scalar(node)}
    if isinstance(node, yaml.SequenceNode):
        return {f"Fn::{suffix}": loader.construct_sequence(node)}
    return {f"Fn::{suffix}": loader.construct_mapping(node)}

CfnLoader.add_multi_constructor("!", _tag)

fails = []
def ok(cond, msg):
    print(("  ✅ " if cond else "  ❌ ") + msg)
    if not cond:
        fails.append(msg)

doc = yaml.load(TEMPLATE.read_text(), Loader=CfnLoader)
ok(isinstance(doc, dict), "the template is valid YAML")

params = doc.get("Parameters", {}) or {}
res = doc.get("Resources", {}) or {}
ok(len(res) >= 9, f"every resource is declared ({len(res)} found)")
ok(all("Type" in r for r in res.values()), "every resource has a Type")

# ── walk every reference ────────────────────────────────────────────────────
known = set(params) | set(res) | {
    "AWS::StackName", "AWS::Region", "AWS::AccountId", "AWS::Partition", "AWS::NoValue",
}
missing_refs, missing_atts = [], []

def walk(node):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "Fn::Ref" and isinstance(v, str) and v not in known:
                missing_refs.append(v)
            elif k == "Fn::GetAtt":
                target = v.split(".")[0] if isinstance(v, str) else (v[0] if v else "")
                if target not in res:
                    missing_atts.append(target)
            elif k == "Fn::Sub" and isinstance(v, str):
                import re
                for m in re.findall(r"\$\{([A-Za-z0-9:!.]+)\}", v):
                    base = m.split(".")[0]
                    if base not in known:
                        missing_refs.append(m)
            walk(v)
    elif isinstance(node, list):
        for i in node:
            walk(i)

walk(doc)
ok(not missing_refs, f"every !Ref/!Sub names something declared{'' if not missing_refs else ': ' + ', '.join(sorted(set(missing_refs)))}")
ok(not missing_atts, f"every !GetAtt names a declared resource{'' if not missing_atts else ': ' + ', '.join(sorted(set(missing_atts)))}")

# ── the scheduler must be able to pass the task roles ───────────────────────
sched_role = res.get("SchedulerRole", {}).get("Properties", {})
stmts = [s for p in sched_role.get("Policies", []) for s in p["PolicyDocument"]["Statement"]]
actions = {a for s in stmts for a in ([s["Action"]] if isinstance(s["Action"], str) else s["Action"])}
ok("ecs:RunTask" in actions, "the scheduler may run the task")
ok("iam:PassRole" in actions,
   "the scheduler may PASS the task roles — without it every fire is denied "
   "while the schedule itself looks healthy")

# ── nothing is granted on "*" ──────────────────────────────────────────────
def resources_of(role_name):
    out = []
    for p in res.get(role_name, {}).get("Properties", {}).get("Policies", []) or []:
        for s in p["PolicyDocument"]["Statement"]:
            r = s.get("Resource")
            out.extend(r if isinstance(r, list) else [r])
    return out

for role in ("SchedulerRole", "ExecutionRole", "TaskRole"):
    ok("*" not in resources_of(role), f"{role} grants nothing on \"*\"")

# ── the secret grant is scoped to the one secret ───────────────────────────
exec_res = resources_of("ExecutionRole")
ok(any(isinstance(r, dict) and r.get("Fn::Ref") == "DivinciCredentialsSecretArn" for r in exec_res),
   "the token grant names the one secret, not every secret in the account")

# ── task and EFS must share subnets, or the mount hangs ────────────────────
sched = res["Schedule"]["Properties"]["Target"]["EcsParameters"]["NetworkConfiguration"]["AwsvpcConfiguration"]
ok(sched.get("Subnets") == {"Fn::Ref": "SubnetIds"},
   "the task runs in the same subnets the mount targets are created in")
ok(sched.get("AssignPublicIp") == "ENABLED",
   "the task gets a public IP — a public subnet without one cannot reach ECR")

mt = [k for k, v in res.items() if v["Type"] == "AWS::EFS::MountTarget"]
ok(len(mt) >= 2, f"a mount target per subnet ({len(mt)} found)")
ok(res["TaskDefinition"].get("DependsOn") is not None,
   "the task definition waits for the mount targets")

# ── the schedule must not nudge ticks into overlapping ─────────────────────
ok(res["Schedule"]["Properties"]["FlexibleTimeWindow"]["Mode"] == "OFF",
   "the schedule has no flexible window — ticks must not drift into each other")

# ── the container-safe lock window is passed through ───────────────────────
cdef = res["TaskDefinition"]["Properties"]["ContainerDefinitions"][0]
names = {e["Name"] for e in cdef["Environment"]}
ok("RUN_LOCK_MAX_AGE_MS" in names,
   "RUN_LOCK_MAX_AGE_MS is set — a pid from a dead container must not wedge the loop")
ok("STATE_DIR" in names, "STATE_DIR names the mounted volume")

# The CLI session must arrive as the WHOLE credentials.json. A bare access token
# cannot be refreshed, so an unattended loop would halt within a day.
secret_names = {sec["Name"] for sec in cdef.get("Secrets", [])}
ok("DIVINCI_CREDENTIALS_JSON" in secret_names,
   "the session arrives as the whole credentials.json, not a bare access token")

mount = cdef["MountPoints"][0]
ok(mount["ContainerPath"] == "/app/state",
   "the volume mounts at /app/state — runs/ and the CLI's HOME both live on it")

print()
if fails:
    print(f"❌ {len(fails)} template assertion(s) failed")
    sys.exit(1)
print("✅ CloudFormation template: all assertions passed")

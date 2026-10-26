"""Extract only output_size from executed parent source; never imports/launches monitor."""
import ast
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

MONITOR=Path(__file__).with_name('q26-r164-range-uncertainty-parent-monitor.py')


def extract_size():
    tree=ast.parse(MONITOR.read_text())
    functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='output_size']
    if len(functions)!=1:raise ValueError('unique output_size required')
    namespace={}
    exec(compile(ast.Module(body=functions,type_ignores=[]),str(MONITOR),'exec'),namespace)
    return namespace['output_size']


class OutputSizeTests(unittest.TestCase):
    def test_vanished_fixture_ignored(self):
        class Vanished:
            def __init__(self,at_check):self.at_check=at_check
            def is_file(self):
                if self.at_check:raise FileNotFoundError('synthetic disappeared fixture')
                return True
            def stat(self):raise FileNotFoundError('synthetic disappeared fixture')
        ordinary=SimpleNamespace(is_file=lambda:True,stat=lambda:SimpleNamespace(st_size=7))
        root=SimpleNamespace(exists=lambda:True,rglob=lambda pattern:[Vanished(True),Vanished(False),ordinary])
        self.assertEqual(extract_size()(root),7)

    def test_permission_propagates(self):
        def denied():raise PermissionError('synthetic denied stat')
        root=SimpleNamespace(exists=lambda:True,rglob=lambda pattern:[SimpleNamespace(is_file=lambda:True,stat=denied)])
        with self.assertRaises(PermissionError):extract_size()(root)

    def test_normal_recursive(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);(root/'a').write_bytes(b'abc');(root/'nested').mkdir();(root/'nested'/'b').write_bytes(b'12345')
            self.assertEqual(extract_size()(root),8)

    def test_absent_root(self):
        def forbidden(_):raise AssertionError('absent root must not be traversed')
        root=SimpleNamespace(exists=lambda:False,rglob=forbidden)
        self.assertEqual(extract_size()(root),0)

if __name__=='__main__':unittest.main()

import unittest
from unittest.mock import patch
import prepare_launch as P
class PrepareTests(unittest.TestCase):
 def test_placeholder_rejected_without_git_or_writes(self):
  with patch.object(P.subprocess,'check_output',side_effect=AssertionError('must not call git')),patch.object(P,'write_new',side_effect=AssertionError('must not write')):
   with self.assertRaises(ValueError):P.prepare('PUBLISHED_O80_COMMIT_REQUIRED')
 def test_current_published_o80_identity(self):
  commit='a'*40
  with patch.object(P.subprocess,'check_output',side_effect=[commit+'\n',commit+'\trefs/heads/main\n','board: O80 operational continuation\n']):P.verify_board(commit)
 def test_wrong_remote_or_tag_rejected(self):
  commit='a'*40
  for remote,message in [('b'*40,'board: O80'),(commit,'board: O79')]:
   with patch.object(P.subprocess,'check_output',side_effect=[commit+'\n',remote+'\trefs/heads/main\n',message+'\n']):
    with self.assertRaises(ValueError):P.verify_board(commit)
if __name__=='__main__':unittest.main()

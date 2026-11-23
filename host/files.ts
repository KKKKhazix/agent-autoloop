// POSIX modes do not protect Windows secrets. A private directory gives new files only the owner's and SYSTEM's access.
import { chmodSync, mkdirSync } from "node:fs";
import { powershell, psQuote } from "./command.ts";

export function privateDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") return chmodSync(directory, 0o700);
  powershell(`
    $folder = ${psQuote(directory)}
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $identityType = [Security.Principal.SecurityIdentifier]
    $identities = @(@($owner.Value, 'S-1-5-18') | Select-Object -Unique)
    $access = [Security.AccessControl.AccessControlSections]::Access
    $sections = $access -bor [Security.AccessControl.AccessControlSections]::Owner
    $current = [IO.Directory]::GetAccessControl($folder, $sections)
    $ownerMatches = $current.GetOwner($identityType).Value -eq $owner.Value
    # A same-volume move can leave an old inherited grant beneath a correct root ACL.
    if ($ownerMatches -and $current.AreAccessRulesProtected) {
      try {
        Add-Type @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading.Tasks;

public static class AutoLoopDirectoryAcl {
  const AceFlags Inheritable = AceFlags.ContainerInherit | AceFlags.ObjectInherit;

  public static bool CanReuse(string folder, DirectorySecurity root, string[] identities) {
    if (!Matches(new RawSecurityDescriptor(root.GetSecurityDescriptorBinaryForm(), 0), Inheritable, identities, false))
      return false;
    var options = new ParallelOptions { MaxDegreeOfParallelism = 4 };
    var inspection = Parallel.ForEach(Entries(folder), options, (item, loop) => {
      if (!MatchesChild(item, identities)) loop.Stop();
    });
    if (!inspection.IsCompleted) return false;

    // The root can change while its descendants are being checked.
    var latest = Directory.GetAccessControl(folder, AccessControlSections.Access | AccessControlSections.Owner);
    return latest.AreAccessRulesProtected &&
      latest.GetOwner(typeof(SecurityIdentifier)).Equals(root.GetOwner(typeof(SecurityIdentifier))) &&
      Matches(new RawSecurityDescriptor(latest.GetSecurityDescriptorBinaryForm(), 0), Inheritable, identities, false);
  }

  static IEnumerable<FileSystemInfo> Entries(string folder) {
    var pending = new Stack<DirectoryInfo>();
    pending.Push(new DirectoryInfo(folder));
    while (pending.Count != 0) {
      foreach (var item in pending.Pop().EnumerateFileSystemInfos()) {
        yield return item;
        var directory = item as DirectoryInfo;
        if (directory != null && (item.Attributes & FileAttributes.ReparsePoint) == 0)
          pending.Push(directory);
      }
    }
  }

  static bool MatchesChild(FileSystemInfo item, string[] identities) {
    if ((item.Attributes & FileAttributes.ReparsePoint) != 0) return false;
    var directory = item as DirectoryInfo;
    FileSystemSecurity security;
    if (directory == null)
      security = ((FileInfo)item).GetAccessControl(AccessControlSections.Access);
    else
      security = directory.GetAccessControl(AccessControlSections.Access);
    var descriptor = new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0);
    var flags = directory == null ? AceFlags.Inherited : Inheritable | AceFlags.Inherited;
    return !security.AreAccessRulesProtected && Matches(descriptor, flags, identities, directory == null);
  }

  static bool Matches(RawSecurityDescriptor descriptor, AceFlags flags, string[] identities, bool allowExplicit) {
    var acl = descriptor.DiscretionaryAcl;
    if (acl == null) return false;
    var seen = new HashSet<string>();
    foreach (GenericAce entry in acl) {
      // A file-only explicit grant does not change inheritance.
      if (allowExplicit && !entry.IsInherited) continue;
      var ace = entry as CommonAce;
      if (ace == null || ace.AceType != AceType.AccessAllowed || ace.AceFlags != flags ||
          ace.AccessMask != (int)FileSystemRights.FullControl) return false;
      var sid = ace.SecurityIdentifier.Value;
      if (Array.IndexOf(identities, sid) < 0 || !seen.Add(sid)) return false;
    }
    return seen.Count == identities.Length;
  }
}
'@
        if ([AutoLoopDirectoryAcl]::CanReuse($folder, $current, [string[]]$identities)) { return }
      } catch {
        # A failed inspection cannot replace the normal ACL repair.
      }
    }

    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    # Setting even the same owner needs the right to take ownership, which a data drive's Modify doesn't give.
    if ([IO.Directory]::GetAccessControl($folder, 'Owner').GetOwner($identityType).Value -ne $owner.Value) {
      $acl.SetOwner($owner)
    }
    foreach ($sid in $identities) {
      $identity = [Security.Principal.SecurityIdentifier]::new($sid)
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    [IO.Directory]::SetAccessControl($folder, $acl)
  `);
}

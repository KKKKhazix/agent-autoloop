param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body
)

# The Windows equivalent of osascript on a Mac and notify-send on Linux. The card's title arrives as an argument, never
# as part of this text, so a title that starts with a dash or contains a quote is still only a title.
$ErrorActionPreference = 'Stop'

try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
    [Windows.UI.Notifications.ToastTemplateType]::ToastText02
  )
  $texts = $template.GetElementsByTagName('text')
  [void]$texts.Item(0).AppendChild($template.CreateTextNode($Title))
  [void]$texts.Item(1).AppendChild($template.CreateTextNode($Body))

  $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
  # A toast has to be shown on behalf of an app the shell knows. PowerShell's own id always is.
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  exit 0
}
catch {
  # A toast needs an interactive shell to register it. msg still reaches the desktop where one is missing.
  try {
    & "$env:SystemRoot\System32\msg.exe" * /TIME:0 "$Title`n$Body" 2>$null | Out-Null
    exit 0
  }
  catch {
    exit 1
  }
}

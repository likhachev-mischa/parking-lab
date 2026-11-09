{{- define "forum.name" -}}
{{- .Release.Name | trunc 48 | trimSuffix "-" -}}
{{- end -}}

{{- define "forum.selector" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "forum.image" -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}

{{- define "forum.claim" -}}
{{- default (printf "%s-data" (include "forum.name" .)) .Values.persistence.existingClaim -}}
{{- end -}}

{{- define "forum.security" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{- define "forum.podSecurity" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "forum.backupToken" -}}
- name: BACKUP_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: backup-token
{{- end -}}

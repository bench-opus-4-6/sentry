import {Fragment, useEffect, useMemo, useState, type MouseEvent} from 'react';
import styled from '@emotion/styled';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import scrollToElement from 'scroll-to-element';
import {z} from 'zod';

import {Alert} from '@sentry/scraps/alert';
import {Button} from '@sentry/scraps/button';
import {
  defaultFormOptions,
  setFieldErrors,
  useScrapsForm,
  useStore,
} from '@sentry/scraps/form';
import {Flex} from '@sentry/scraps/layout';
import {ExternalLink} from '@sentry/scraps/link';
import {Tooltip} from '@sentry/scraps/tooltip';

import {
  addErrorMessage,
  addLoadingMessage,
  addSuccessMessage,
} from 'sentry/actionCreators/indicator';
import {openModal} from 'sentry/actionCreators/modal';
import type {ApiResult} from 'sentry/api';
import {AvatarChooser} from 'sentry/components/avatarChooser';
import {Confirm} from 'sentry/components/confirm';
import {EmptyMessage} from 'sentry/components/emptyMessage';
import {FormField} from 'sentry/components/forms/formField';
import {LoadingError} from 'sentry/components/loadingError';
import {LoadingIndicator} from 'sentry/components/loadingIndicator';
import {Panel} from 'sentry/components/panels/panel';
import {PanelBody} from 'sentry/components/panels/panelBody';
import {PanelHeader} from 'sentry/components/panels/panelHeader';
import {PanelTable} from 'sentry/components/panels/panelTable';
import {TextCopyInput} from 'sentry/components/textCopyInput';
import {ALLOWED_SCOPES} from 'sentry/constants';
import {IconAdd} from 'sentry/icons';
import {t, tct} from 'sentry/locale';
import type {Avatar} from 'sentry/types/core';
import type {SentryApp, SentryAppAvatar, WebhookEvent} from 'sentry/types/integrations';
import type {InternalAppApiToken, NewInternalAppApiToken} from 'sentry/types/user';
import {convertMultilineFieldValue, extractMultilineFields} from 'sentry/utils';
import {getApiUrl} from 'sentry/utils/api/getApiUrl';
import {
  fetchMutation,
  setApiQueryData,
  useApiQuery,
  type ApiQueryKey,
} from 'sentry/utils/queryClient';
import {RequestError} from 'sentry/utils/requestError/requestError';
import {normalizeUrl} from 'sentry/utils/url/normalizeUrl';
import {useLocation} from 'sentry/utils/useLocation';
import {useNavigate} from 'sentry/utils/useNavigate';
import {useOrganization} from 'sentry/utils/useOrganization';
import {useParams} from 'sentry/utils/useParams';
import {useRoutes} from 'sentry/utils/useRoutes';
import {useHasPageFrameFeature} from 'sentry/views/navigation/useHasPageFrameFeature';
import {ApiTokenRow} from 'sentry/views/settings/account/apiTokenRow';
import {displayNewToken} from 'sentry/views/settings/components/newTokenHandler';
import {BreadcrumbTitle} from 'sentry/views/settings/components/settingsBreadcrumb/breadcrumbTitle';
import {SettingsPageHeader} from 'sentry/views/settings/components/settingsPageHeader';
import {EVENT_CHOICES} from 'sentry/views/settings/organizationDeveloperSettings/constants';
import {PermissionsObserver} from 'sentry/views/settings/organizationDeveloperSettings/permissionsObserver';

const AVATAR_STYLES = {
  color: {
    label: t('Default logo'),
    description: t('The default icon for integrations'),
    help: t('Image must be between 256px by 256px and 1024px by 1024px.'),
  },
  simple: {
    label: t('Default small icon'),
    description: tct('This is a silhouette icon used only for [uiDocs:UI Components]', {
      uiDocs: (
        <ExternalLink href="https://docs.sentry.io/product/integrations/integration-platform/ui-components/" />
      ),
    }),
    help: t(
      'Image must be between 256px by 256px and 1024px by 1024px, and may only use black and transparent pixels.'
    ),
  },
};

type FormErrorField =
  | 'name'
  | 'author'
  | 'webhookUrl'
  | 'redirectUrl'
  | 'verifyInstall'
  | 'isAlertable'
  | 'schema'
  | 'overview'
  | 'allowedOrigins';

const FORM_ERROR_FIELDS: FormErrorField[] = [
  'name',
  'author',
  'webhookUrl',
  'redirectUrl',
  'verifyInstall',
  'isAlertable',
  'schema',
  'overview',
  'allowedOrigins',
];

const sentryAppFormSchema = z
  .object({
    name: z.string(),
    author: z.string(),
    webhookUrl: z.string(),
    redirectUrl: z.string(),
    verifyInstall: z.boolean(),
    isAlertable: z.boolean(),
    schema: z.string(),
    overview: z.string(),
    allowedOrigins: z.string(),
    organization: z.string(),
    isInternal: z.boolean(),
    scopes: z.array(z.enum(ALLOWED_SCOPES)),
    events: z.array(z.enum(EVENT_CHOICES)),
  })
  .superRefine((data, ctx) => {
    if (!data.name.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: t('This field is required'),
        path: ['name'],
      });
    }

    if (!data.isInternal && !data.author.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: t('This field is required'),
        path: ['author'],
      });
    }

    if (!data.isInternal && !data.webhookUrl.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: t('This field is required'),
        path: ['webhookUrl'],
      });
    }

    if (data.schema.trim()) {
      try {
        JSON.parse(data.schema);
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: t('Invalid JSON'),
          path: ['schema'],
        });
      }
    }
  });

type SentryApplicationFormData = z.infer<typeof sentryAppFormSchema>;

type SaveSentryAppPayload = {
  allowedOrigins: string[];
  events: string[];
  isAlertable: boolean;
  isInternal: boolean;
  name: string;
  organization: string;
  schema: Record<string, unknown>;
  scopes: string[];
  verifyInstall: boolean;
  webhookUrl: string;
  author?: string;
  overview?: string;
  redirectUrl?: string;
};

type RotateSecretResponse = {
  clientSecret: string;
};

const makeSentryAppQueryKey = (appSlug: string): ApiQueryKey => {
  return [
    getApiUrl('/sentry-apps/$sentryAppIdOrSlug/', {
      path: {sentryAppIdOrSlug: appSlug},
    }),
  ];
};

const makeSentryAppApiTokensQueryKey = (appSlug: string): ApiQueryKey => {
  return [
    getApiUrl('/sentry-apps/$sentryAppIdOrSlug/api-tokens/', {
      path: {sentryAppIdOrSlug: appSlug},
    }),
  ];
};

function getSchemaFieldValue(schema: SentryApp['schema'] | null | undefined) {
  const formattedSchema = JSON.stringify(schema ?? {}, null, 2);
  return formattedSchema === '{}' ? '' : formattedSchema;
}

function normalizeWebhookEvents(events: WebhookEvent[]) {
  if (events.length === 0) {
    return events;
  }

  return events.map(event => event.split('.').shift() as WebhookEvent);
}

function getErrorMessages(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((message): message is string => typeof message === 'string');
  }

  return [];
}

function getTopLevelErrorMessage(responseJSON: unknown) {
  if (typeof responseJSON === 'string') {
    return responseJSON;
  }

  if (typeof responseJSON !== 'object' || responseJSON === null) {
    return null;
  }

  const response = responseJSON as Record<string, unknown>;

  if (typeof response.detail === 'string') {
    return response.detail;
  }

  if (
    Array.isArray(response.non_field_errors) &&
    typeof response.non_field_errors[0] === 'string'
  ) {
    return response.non_field_errors[0];
  }

  return null;
}

function getVisibleFieldErrors(responseJSON: unknown) {
  if (typeof responseJSON !== 'object' || responseJSON === null) {
    return {};
  }

  const response = responseJSON as Record<string, unknown>;

  return FORM_ERROR_FIELDS.reduce<Partial<Record<FormErrorField, {message: string}>>>(
    (errors, fieldName) => {
      const [message] = getErrorMessages(response[fieldName]);
      if (message) {
        errors[fieldName] = {message};
      }
      return errors;
    },
    {}
  );
}

export default function SentryApplicationDetails() {
  const location = useLocation();
  const {appSlug} = useParams<{appSlug: string}>();
  const organization = useOrganization();
  const routes = useRoutes();
  const hasPageFrame = useHasPageFrameFeature();
  const isEditingApp = !!appSlug;

  const queryClient = useQueryClient();

  const SENTRY_APP_QUERY_KEY = makeSentryAppQueryKey(appSlug);

  const {
    data: app,
    isPending,
    isError,
    refetch,
  } = useApiQuery<SentryApp>(SENTRY_APP_QUERY_KEY, {
    staleTime: 30000,
    enabled: isEditingApp,
    placeholderData: () => {
      if (!appSlug) {
        return;
      }

      // eslint-disable-next-line @sentry/no-query-data-type-parameters
      const listData = queryClient.getQueryData<ApiResult<SentryApp[]>>([
        getApiUrl('/organizations/$organizationIdOrSlug/sentry-apps/', {
          path: {organizationIdOrSlug: organization.slug},
        }),
      ]);

      if (!listData) {
        return;
      }

      const found = listData[0].find(item => item.slug === appSlug);
      return found ? [found, listData[1], listData[2]] : undefined;
    },
  });

  const isInternal = app
    ? app.status === 'internal'
    : location.pathname.endsWith('new-internal/');

  const headerTitle = app
    ? isInternal
      ? t('Edit Internal Integration')
      : t('Edit Public Integration')
    : isInternal
      ? t('Create Internal Integration')
      : t('Create Public Integration');

  return (
    <div>
      {hasPageFrame ? (
        <BreadcrumbTitle
          routes={routes}
          title={isEditingApp ? (app?.name ?? '') : t('New')}
        />
      ) : (
        <SettingsPageHeader title={headerTitle} />
      )}

      {isEditingApp && isPending ? (
        <LoadingIndicator />
      ) : isEditingApp && isError ? (
        <LoadingError onRetry={refetch} />
      ) : (
        <SentryApplicationDetailsForm
          app={app}
          isInternal={isInternal}
          refetch={refetch}
        />
      )}
    </div>
  );
}

function SentryApplicationDetailsForm({
  app,
  isInternal,
  refetch,
}: {
  app: SentryApp | undefined;
  isInternal: boolean;
  refetch: () => void;
}) {
  const navigate = useNavigate();
  const {appSlug} = useParams<{appSlug: string}>();
  const organization = useOrganization();
  const queryClient = useQueryClient();

  const SENTRY_APP_QUERY_KEY = makeSentryAppQueryKey(appSlug);
  const SENTRY_APP_API_TOKENS_QUERY_KEY = makeSentryAppApiTokensQueryKey(appSlug);

  const isEditingApp = !!appSlug;

  const {data: tokens = []} = useApiQuery<InternalAppApiToken[]>(
    SENTRY_APP_API_TOKENS_QUERY_KEY,
    {
      staleTime: 30000,
      enabled: isEditingApp,
    }
  );

  const [newTokens, setNewTokens] = useState<NewInternalAppApiToken[]>([]);

  const hasTokenAccess = organization.access.includes('org:write');

  const showAuthInfo = app?.clientSecret?.[0] !== '*';

  const addTokenMutation = useMutation({
    mutationFn: (sentryAppSlug: string) =>
      fetchMutation<NewInternalAppApiToken>({
        url: `/sentry-apps/${sentryAppSlug}/api-tokens/`,
        method: 'POST',
      }),
    onMutate: () => {
      addLoadingMessage();
    },
    onSuccess: () => {
      addSuccessMessage(t('Token successfully added.'));
    },
    onError: () => {
      addErrorMessage(t('Unable to create token'));
    },
  });

  const removeTokenMutation = useMutation({
    mutationFn: ({sentryAppSlug, tokenId}: {sentryAppSlug: string; tokenId: string}) =>
      fetchMutation({
        url: `/sentry-apps/${sentryAppSlug}/api-tokens/${tokenId}/`,
        method: 'DELETE',
      }),
    onMutate: () => {
      addLoadingMessage();
    },
    onSuccess: () => {
      addSuccessMessage(t('Token successfully deleted.'));
    },
    onError: () => {
      addErrorMessage(t('Unable to delete token'));
    },
  });

  const rotateClientSecretMutation = useMutation({
    mutationFn: (sentryAppSlug: string) =>
      fetchMutation<RotateSecretResponse>({
        url: `/sentry-apps/${sentryAppSlug}/rotate-secret/`,
        method: 'POST',
      }),
  });

  const handleSubmitSuccess = (data: Partial<SentryApp>) => {
    const type = isInternal ? 'internal' : 'public';
    const baseUrl = `/settings/${organization.slug}/developer-settings/`;
    const url = app ? `${baseUrl}?type=${type}` : `${baseUrl}${data.slug}/`;

    if (app) {
      addSuccessMessage(t('%s successfully saved.', data.name));
      refetch();
    } else {
      addSuccessMessage(t('%s successfully created.', data.name));
    }

    navigate(normalizeUrl(url));
  };

  const onAddToken = async (event: MouseEvent<HTMLButtonElement>): Promise<void> => {
    event.preventDefault();
    if (!app) {
      return;
    }

    const token = await addTokenMutation.mutateAsync(app.slug);
    const updatedNewTokens = newTokens.concat(token);
    setNewTokens(updatedNewTokens);
    displayNewToken(token.token, () => handleFinishNewToken(token));
  };

  const handleFinishNewToken = (newToken: NewInternalAppApiToken) => {
    const updatedNewTokens = newTokens.filter(token => token.id !== newToken.id);
    const updatedTokens = tokens.concat(newToken);
    setApiQueryData(queryClient, SENTRY_APP_API_TOKENS_QUERY_KEY, updatedTokens);
    setNewTokens(updatedNewTokens);
  };

  const onRemoveToken = async (token: InternalAppApiToken) => {
    if (!app) {
      return;
    }

    const updatedTokens = tokens.filter(tok => tok.id !== token.id);
    await removeTokenMutation.mutateAsync({sentryAppSlug: app.slug, tokenId: token.id});
    setApiQueryData(queryClient, SENTRY_APP_API_TOKENS_QUERY_KEY, updatedTokens);
  };

  const renderTokens = () => {
    if (!hasTokenAccess) {
      return (
        <EmptyMessage>{t('You do not have access to view these tokens.')}</EmptyMessage>
      );
    }

    if (tokens.length < 1 && newTokens.length < 1) {
      return <EmptyMessage>{t('No tokens created yet.')}</EmptyMessage>;
    }

    return tokens.map(token => (
      <ApiTokenRow
        data-test-id="api-token"
        key={token.id}
        token={token}
        onRemove={onRemoveToken}
      />
    ));
  };

  const rotateClientSecret = async () => {
    if (!appSlug) {
      return;
    }

    const rotateResponse = await rotateClientSecretMutation.mutateAsync(appSlug);

    requestAnimationFrame(() => {
      openModal(({Body, Header}) => (
        <Fragment>
          <Header>{t('Your new Client Secret')}</Header>
          <Body>
            <Alert.Container>
              <Alert variant="info">
                {t('This will be the only time your client secret is visible!')}
              </Alert>
            </Alert.Container>
            <TextCopyInput aria-label={t('new-client-secret')}>
              {rotateResponse.clientSecret}
            </TextCopyInput>
          </Body>
        </Fragment>
      ));
    });
  };

  const addAvatar = ({avatar}: {avatar?: Avatar}) => {
    if (app && avatar) {
      const avatars =
        app.avatars?.filter(prevAvatar => prevAvatar.color !== avatar.color) ?? [];

      avatars.push(avatar as SentryAppAvatar);
      setApiQueryData(queryClient, SENTRY_APP_QUERY_KEY, {...app, avatars});
    }
  };

  const [scopeErrors, setScopeErrors] = useState<string[]>([]);
  const [eventErrors, setEventErrors] = useState<string[]>([]);

  const defaultValues = useMemo(
    () => ({
      name: app?.name ?? '',
      author: app?.author ?? '',
      webhookUrl: app?.webhookUrl ?? '',
      redirectUrl: app?.redirectUrl ?? '',
      verifyInstall: isInternal ? false : (app?.verifyInstall ?? true),
      isAlertable: app?.isAlertable ?? false,
      schema: getSchemaFieldValue(app?.schema),
      overview: app?.overview ?? '',
      allowedOrigins: convertMultilineFieldValue(app?.allowedOrigins ?? []),
      organization: organization.slug,
      isInternal,
      scopes: app ? [...app.scopes] : [],
      events: app ? normalizeWebhookEvents(app.events) : [],
    }),
    [app, isInternal, organization.slug]
  );

  const saveSentryAppMutation = useMutation({
    mutationFn: (data: SaveSentryAppPayload) =>
      fetchMutation<SentryApp>({
        url: app ? `/sentry-apps/${app.slug}/` : '/sentry-apps/',
        method: app ? 'PUT' : 'POST',
        data,
      }),
    onSuccess: handleSubmitSuccess,
  });

  const form = useScrapsForm({
    ...defaultFormOptions,
    defaultValues,
    validators: {
      onDynamic: sentryAppFormSchema,
    },
    onSubmit: ({value, formApi}) => {
      setScopeErrors([]);
      setEventErrors([]);

      const payload: SaveSentryAppPayload = {
        name: value.name,
        organization: value.organization,
        webhookUrl: value.webhookUrl,
        isAlertable: value.isAlertable,
        isInternal: value.isInternal,
        verifyInstall: value.verifyInstall,
        scopes: value.scopes,
        events: value.events,
        allowedOrigins: extractMultilineFields(value.allowedOrigins),
        schema: value.schema.trim() === '' ? {} : JSON.parse(value.schema),
        author: value.author,
        redirectUrl: value.redirectUrl,
        overview: value.overview,
      };

      return saveSentryAppMutation.mutateAsync(payload).catch(error => {
        if (!(error instanceof RequestError)) {
          addErrorMessage(t('Unknown Error'));
          return;
        }

        const nextScopeErrors = getErrorMessages(error.responseJSON?.scopes);
        const nextEventErrors = getErrorMessages(error.responseJSON?.events);
        const visibleFieldErrors = getVisibleFieldErrors(error.responseJSON);
        const topLevelErrorMessage = getTopLevelErrorMessage(error.responseJSON);

        setScopeErrors(nextScopeErrors);
        setEventErrors(nextEventErrors);

        if (Object.keys(visibleFieldErrors).length > 0) {
          setFieldErrors(
            formApi,
            visibleFieldErrors as Partial<
              Record<keyof SentryApplicationFormData, {message: string}>
            >
          );
        }

        addErrorMessage(topLevelErrorMessage ?? t('Unknown Error'));

        requestAnimationFrame(() => {
          const invalidInput = document.querySelector(
            `#${CSS.escape(formApi.formId)} [aria-invalid="true"]`
          );
          if (invalidInput instanceof HTMLElement) {
            scrollToElement(invalidInput, {align: 'middle', offset: 0});
          }
        });
      });
    },
  });

  const webhookUrl = useStore(form.store, state => state.values.webhookUrl);
  const isAlertable = useStore(form.store, state => state.values.isAlertable);
  const webhookDisabled = isInternal && !webhookUrl;

  useEffect(() => {
    if (webhookDisabled && isAlertable) {
      form.setFieldValue('isAlertable', false);
    }
  }, [form, isAlertable, webhookDisabled]);

  return (
    <form.AppForm form={form}>
      <form.FieldGroup
        title={
          isInternal ? t('Internal Integration Details') : t('Public Integration Details')
        }
      >
        <form.AppField name="name">
          {field => (
            <field.Layout.Row
              label={t('Name')}
              hintText={t('Human readable name of your Integration.')}
              required
            >
              <field.Input
                value={field.state.value}
                onChange={field.handleChange}
                placeholder={t('e.g. My Integration')}
              />
            </field.Layout.Row>
          )}
        </form.AppField>

        {!isInternal && (
          <form.AppField name="author">
            {field => (
              <field.Layout.Row
                label={t('Author')}
                hintText={t(
                  'The company or person who built and maintains this Integration.'
                )}
                required
              >
                <field.Input
                  value={field.state.value}
                  onChange={field.handleChange}
                  placeholder={t('e.g. Acme Software')}
                />
              </field.Layout.Row>
            )}
          </form.AppField>
        )}

        <form.AppField name="webhookUrl">
          {field => (
            <field.Layout.Row
              label={t('Webhook URL')}
              hintText={tct(
                'All webhook requests for your integration will be sent to this URL. Visit the [webhookDocs:documentation] to see the different types and payloads.',
                {
                  webhookDocs: (
                    <ExternalLink href="https://docs.sentry.io/product/integrations/integration-platform/webhooks/" />
                  ),
                }
              )}
              required={!isInternal}
            >
              <field.Input
                value={field.state.value}
                onChange={field.handleChange}
                placeholder={t('e.g. https://example.com/sentry/webhook/')}
              />
            </field.Layout.Row>
          )}
        </form.AppField>

        {!isInternal && (
          <form.AppField name="redirectUrl">
            {field => (
              <field.Layout.Row
                label={t('Redirect URL')}
                hintText={t('The URL Sentry will redirect users to after installation.')}
              >
                <field.Input
                  value={field.state.value}
                  onChange={field.handleChange}
                  placeholder={t('e.g. https://example.com/sentry/setup/')}
                />
              </field.Layout.Row>
            )}
          </form.AppField>
        )}

        {!isInternal && (
          <form.AppField name="verifyInstall">
            {field => (
              <field.Layout.Row
                label={t('Verify Installation')}
                hintText={t(
                  'If enabled, installations will need to be verified before becoming installed.'
                )}
              >
                <field.Switch checked={field.state.value} onChange={field.handleChange} />
              </field.Layout.Row>
            )}
          </form.AppField>
        )}

        <form.AppField name="isAlertable">
          {field => (
            <field.Layout.Row
              label={t('Alert Rule Action')}
              hintText={tct(
                'If enabled, this integration will be available in Issue Alert rules and Metric Alert rules in Sentry. The notification destination is the Webhook URL specified above. More on actions [learnMore:here].',
                {
                  learnMore: (
                    <ExternalLink href="https://docs.sentry.io/product/alerts-notifications/notifications/" />
                  ),
                }
              )}
            >
              <field.Switch
                checked={field.state.value}
                onChange={field.handleChange}
                disabled={
                  webhookDisabled
                    ? t('Cannot enable alert rule action without a webhook url')
                    : false
                }
              />
            </field.Layout.Row>
          )}
        </form.AppField>

        <form.AppField name="schema">
          {field => (
            <field.Layout.Row
              label={t('Schema')}
              hintText={tct(
                'Schema for your UI components. Click [schemaDocs:here] for documentation.',
                {
                  schemaDocs: (
                    <ExternalLink href="https://docs.sentry.io/product/integrations/integration-platform/ui-components/" />
                  ),
                }
              )}
            >
              <field.TextArea
                autosize
                value={field.state.value}
                onChange={field.handleChange}
              />
            </field.Layout.Row>
          )}
        </form.AppField>

        <form.AppField name="overview">
          {field => (
            <field.Layout.Row
              label={t('Overview')}
              hintText={t('Description of your Integration and its functionality.')}
            >
              <field.TextArea
                autosize
                value={field.state.value}
                onChange={field.handleChange}
              />
            </field.Layout.Row>
          )}
        </form.AppField>

        <form.AppField name="allowedOrigins">
          {field => (
            <field.Layout.Row
              label={t('Authorized JavaScript Origins')}
              hintText={t('Separate multiple entries with a newline.')}
            >
              <field.TextArea
                autosize
                value={field.state.value}
                onChange={field.handleChange}
                placeholder={t('e.g. example.com')}
              />
            </field.Layout.Row>
          )}
        </form.AppField>
      </form.FieldGroup>

      {app && (
        <Fragment>
          <AvatarChooser
            endpoint={`/sentry-apps/${app.slug}/avatar/`}
            supportedTypes={['default', 'upload']}
            type="sentryAppColor"
            model={app}
            onSave={addAvatar}
            title={t('Logo')}
            help={AVATAR_STYLES.color.help.concat(
              isInternal ? '' : t(' Required for publishing.')
            )}
            defaultChoice={{
              label: AVATAR_STYLES.color.label,
              description: AVATAR_STYLES.color.description,
            }}
          />
          <AvatarChooser
            endpoint={`/sentry-apps/${app.slug}/avatar/`}
            supportedTypes={['default', 'upload']}
            type="sentryAppSimple"
            model={app}
            onSave={addAvatar}
            title={t('Small Icon')}
            help={AVATAR_STYLES.simple.help.concat(
              isInternal ? '' : t(' Required for publishing.')
            )}
            defaultChoice={{
              label: AVATAR_STYLES.simple.label,
              description: AVATAR_STYLES.simple.description,
            }}
          />
        </Fragment>
      )}

      {scopeErrors.length > 0 && (
        <Alert.Container>
          <Alert variant="danger">
            {scopeErrors.map((error, index) => (
              <div key={`${index}-${error}`}>{error}</div>
            ))}
          </Alert>
        </Alert.Container>
      )}
      <PermissionsObserver
        webhookDisabled={webhookDisabled}
        appPublished={app ? app.status === 'published' : false}
        scopes={app ? [...app.scopes] : []}
        events={app ? normalizeWebhookEvents(app.events) : []}
        newApp={!app}
        onScopesChange={scopes => {
          setScopeErrors([]);
          form.setFieldValue('scopes', scopes);
        }}
        onEventsChange={events => {
          setEventErrors([]);
          form.setFieldValue('events', events);
        }}
      />
      {eventErrors.length > 0 && (
        <Alert.Container>
          <Alert variant="danger">
            {eventErrors.map((error, index) => (
              <div key={`${index}-${error}`}>{error}</div>
            ))}
          </Alert>
        </Alert.Container>
      )}

      {app?.status === 'internal' && (
        <PanelTable
          headers={[
            t('Token'),
            t('Created On'),
            t('Scopes'),
            <AddTokenHeader key="token-add">
              <Button
                size="xs"
                icon={<IconAdd />}
                onClick={onAddToken}
                data-test-id="token-add"
              >
                {t('New Token')}
              </Button>
            </AddTokenHeader>,
          ]}
          isEmpty={tokens.length === 0}
          emptyMessage={t("You haven't created any authentication tokens yet.")}
        >
          {renderTokens()}
        </PanelTable>
      )}

      {app && (
        <Panel>
          <PanelHeader>{t('Credentials')}</PanelHeader>
          <PanelBody>
            {app.status !== 'internal' && (
              <FormField name="clientId" label="Client ID">
                {({id}: any) => (
                  <TextCopyInput id={id}>{app.clientId ?? ''}</TextCopyInput>
                )}
              </FormField>
            )}
            <FormField
              name="clientSecret"
              label="Client Secret"
              help={t(`Your secret is only available briefly after integration creation. Make
                sure to save this value!`)}
            >
              {({id}: any) =>
                app.clientSecret ? (
                  <Tooltip
                    disabled={showAuthInfo}
                    position="right"
                    containerDisplayMode="inline"
                    title={t(
                      'Only Manager or Owner can view these credentials, or the permissions for this integration exceed those of your role.'
                    )}
                  >
                    <TextCopyInput id={id}>{app.clientSecret}</TextCopyInput>
                  </Tooltip>
                ) : (
                  <ClientSecret>
                    <HiddenSecret>{t('hidden')}</HiddenSecret>
                    {hasTokenAccess ? (
                      <Confirm
                        onConfirm={rotateClientSecret}
                        message={t(
                          'Are you sure you want to rotate the client secret? The current one will not be usable anymore, and this cannot be undone.'
                        )}
                        errorMessage={t('Error rotating secret')}
                      >
                        <Button variant="danger">{t('Rotate client secret')}</Button>
                      </Confirm>
                    ) : undefined}
                  </ClientSecret>
                )
              }
            </FormField>
          </PanelBody>
        </Panel>
      )}

      <Flex justify="end" paddingTop="xl">
        <form.SubmitButton aria-label={t('Save Changes')}>
          {t('Save Changes')}
        </form.SubmitButton>
      </Flex>
    </form.AppForm>
  );
}

const HiddenSecret = styled('span')`
  width: 100px;
  font-style: italic;
`;

const ClientSecret = styled('div')`
  display: flex;
  justify-content: right;
  align-items: center;
  margin-right: 0;
`;

const AddTokenHeader = styled('div')`
  margin: -${p => p.theme.space.md} 0;
  display: flex;
  justify-content: flex-end;
`;

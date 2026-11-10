// Pre-Plan Follow-Up Portal: Azure infrastructure.
//   App Service plan (Linux) + Web App (Python 3.12, gunicorn/uvicorn)
//   Storage account + private blob container for meeting photos (with a lifecycle delete rule)
//   Azure Database for PostgreSQL Flexible Server + database
// Deploy:  az deployment group create -g <rg> -f infra/main.bicep -p appName=<name> postgresAdminPassword=<pw> secretKey=<key>
// (deploy/deploy.sh does all of this for you.)

targetScope = 'resourceGroup'

@description('Base name of the web app. Must be globally unique (becomes <appName>.azurewebsites.net).')
@minLength(3)
@maxLength(40)
param appName string

@description('Region for all resources.')
param location string = resourceGroup().location

@description('Region for the PostgreSQL server (some subscriptions cannot create PostgreSQL in every region).')
param postgresLocation string = location

@description('App Service plan SKU. Premium v3 supports autoscale; P0v3 x 2-10 instances (1 vCPU / 4 GB each) handles ~1,350 concurrent uploaders.')
@allowed([
  'B1'
  'B2'
  'B3'
  'S1'
  'S2'
  'S3'
  'P0v3'
  'P1v3'
  'P2v3'
  'P3v3'
])
param sku string = 'P0v3'

@description('Minimum (and initial) number of web instances.')
@minValue(1)
@maxValue(30)
param minInstances int = 2

@description('Maximum number of web instances the autoscale rule may add (Standard/Premium SKUs only).')
@minValue(1)
@maxValue(30)
param maxInstances int = 10

@description('Gunicorn worker processes per instance.')
@minValue(1)
@maxValue(16)
param webConcurrency int = 3

@description('SQLAlchemy connection pool size per worker process (pool + overflow). Keep maxInstances x webConcurrency x (pool + overflow) below the PostgreSQL max_connections.')
param dbPoolSize int = 5
param dbMaxOverflow int = 5

@description('Days of photos/reports that stay viewable; older photos are deleted.')
@minValue(1)
param retentionDays int = 3

@description('PostgreSQL compute SKU. Standard_D2ds_v5 (General Purpose, ~859 connections) for production; Standard_B1ms (Burstable, ~50 connections) only for small trials with 1 instance.')
param postgresSkuName string = 'Standard_D2ds_v5'

@description('PostgreSQL tier matching postgresSkuName.')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param postgresTier string = 'GeneralPurpose'

@description('PostgreSQL storage size in GB (photos live in Blob Storage, not in the database).')
param postgresStorageGB int = 32

@description('PostgreSQL administrator login name.')
param postgresAdminLogin string = 'preplanadmin'

@description('PostgreSQL administrator password.')
@secure()
@minLength(12)
param postgresAdminPassword string

@description('Secret used to sign session cookies (long random string).')
@secure()
@minLength(32)
param secretKey string

@description('Blob container for the meeting photos.')
param storageContainerName string = 'meeting-images'

@description('Database name.')
param databaseName string = 'preplan'

param tags object = {
  app: 'preplan-portal'
}

var suffix = uniqueString(resourceGroup().id, appName)
var planName = '${appName}-plan'
var storageName = take('st${replace(toLower(appName), '-', '')}${suffix}', 24)
var postgresName = take('${toLower(appName)}-pg-${suffix}', 63)
var autoscaleSupported = startsWith(sku, 'S') || startsWith(sku, 'P')
var initialInstances = autoscaleSupported ? minInstances : min(minInstances, 3)

// ---------------------------------------------------------------- Storage
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowSharedKeyAccess: true // the app signs short-lived read SAS URLs with the account key
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: storageContainerName
  properties: {
    publicAccess: 'None'
  }
}

// Safety net next to the app's own purge job: delete photo blobs a day after they leave the retention window.
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'delete-old-meeting-photos'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${storageContainerName}/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterCreationGreaterThan: retentionDays + 1
                }
              }
            }
          }
        }
      ]
    }
  }
  dependsOn: [
    container
  ]
}

// ---------------------------------------------------------------- PostgreSQL
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresName
  location: postgresLocation
  tags: tags
  sku: {
    name: postgresSkuName
    tier: postgresTier
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: postgresStorageGB
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
  }
}

// 0.0.0.0 - 0.0.0.0 = "Allow public access from any Azure service" (App Service outbound IPs).
resource pgFirewallAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource pgDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// ---------------------------------------------------------------- App Service
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: sku
    capacity: initialInstances
  }
  properties: {
    reserved: true // Linux
  }
}

var databaseUrl = 'postgresql+psycopg://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=require'
var storageConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'

resource webApp 'Microsoft.Web/sites@2024-04-01' = {
  name: appName
  location: location
  tags: tags
  kind: 'app,linux'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false // sessions live in a signed cookie, any instance can serve any request
    siteConfig: {
      linuxFxVersion: 'PYTHON|3.12'
      appCommandLine: 'bash startup.sh'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      healthCheckPath: '/healthz'
      appSettings: [
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
        {
          name: 'WEBSITES_CONTAINER_START_TIME_LIMIT'
          value: '900'
        }
        {
          name: 'DATABASE_URL'
          value: databaseUrl
        }
        {
          name: 'SECRET_KEY'
          value: secretKey
        }
        {
          name: 'STORAGE_BACKEND'
          value: 'azure'
        }
        {
          name: 'AZURE_STORAGE_CONNECTION_STRING'
          value: storageConnectionString
        }
        {
          name: 'AZURE_STORAGE_CONTAINER'
          value: storageContainerName
        }
        {
          name: 'COOKIE_SECURE'
          value: 'true'
        }
        {
          name: 'APP_TIMEZONE'
          value: 'Asia/Dhaka'
        }
        {
          name: 'RETENTION_DAYS'
          value: string(retentionDays)
        }
        {
          name: 'WEB_CONCURRENCY'
          value: string(webConcurrency)
        }
        {
          name: 'DB_POOL_SIZE'
          value: string(dbPoolSize)
        }
        {
          name: 'DB_MAX_OVERFLOW'
          value: string(dbMaxOverflow)
        }
      ]
    }
  }
  dependsOn: [
    pgDatabase
    pgFirewallAzure
    container
  ]
}

// No FTP publishing; deployments go through the Kudu (SCM) zip deploy API.
resource ftpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: webApp
  name: 'ftp'
  properties: {
    allow: false
  }
}

resource logs 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: webApp
  name: 'logs'
  properties: {
    applicationLogs: {
      fileSystem: {
        level: 'Information'
      }
    }
    httpLogs: {
      fileSystem: {
        enabled: true
        retentionInDays: 7
        retentionInMb: 100
      }
    }
  }
}

// Scale out on CPU / HTTP queue during the morning upload burst, back in when idle.
resource autoscale 'Microsoft.Insights/autoscalesettings@2022-10-01' = if (autoscaleSupported && maxInstances > minInstances) {
  name: '${planName}-autoscale'
  location: location
  tags: tags
  properties: {
    enabled: true
    targetResourceUri: plan.id
    profiles: [
      {
        name: 'default'
        capacity: {
          minimum: string(minInstances)
          maximum: string(maxInstances)
          default: string(minInstances)
        }
        rules: [
          {
            metricTrigger: {
              metricName: 'CpuPercentage'
              metricResourceUri: plan.id
              timeGrain: 'PT1M'
              statistic: 'Average'
              timeWindow: 'PT5M'
              timeAggregation: 'Average'
              operator: 'GreaterThan'
              threshold: 65
            }
            scaleAction: {
              direction: 'Increase'
              type: 'ChangeCount'
              value: '2'
              cooldown: 'PT5M'
            }
          }
          {
            metricTrigger: {
              metricName: 'HttpQueueLength'
              metricResourceUri: plan.id
              timeGrain: 'PT1M'
              statistic: 'Average'
              timeWindow: 'PT5M'
              timeAggregation: 'Average'
              operator: 'GreaterThan'
              threshold: 50
            }
            scaleAction: {
              direction: 'Increase'
              type: 'ChangeCount'
              value: '1'
              cooldown: 'PT5M'
            }
          }
          {
            metricTrigger: {
              metricName: 'CpuPercentage'
              metricResourceUri: plan.id
              timeGrain: 'PT1M'
              statistic: 'Average'
              timeWindow: 'PT15M'
              timeAggregation: 'Average'
              operator: 'LessThan'
              threshold: 25
            }
            scaleAction: {
              direction: 'Decrease'
              type: 'ChangeCount'
              value: '1'
              cooldown: 'PT15M'
            }
          }
        ]
      }
    ]
  }
}

output webAppName string = webApp.name
output webAppUrl string = 'https://${webApp.properties.defaultHostName}'
output postgresServerName string = postgres.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output storageAccountName string = storage.name
